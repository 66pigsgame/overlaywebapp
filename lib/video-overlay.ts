import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPathRaw from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { CHROME } from "./colors";
import { PAD_RATIO, FONT_SIZE_RATIO, BOX_HEIGHT_RATIO } from "./geometry";
import { renderChromeLine } from "./chrome-render";

if (!ffmpegPathRaw) {
  throw new Error("ffmpeg-static did not resolve a binary path for this platform");
}
const bundledFfmpegPath: string = ffmpegPathRaw;
const bundledFfprobePath: string = ffprobeStatic.path;

// Vercel's serverless packaging doesn't reliably preserve the executable
// bit on file-traced binaries, and the bundle's own directory can be
// read-only at runtime. Copy each binary into /tmp (writable) and chmod
// it there once per cold start; cached so repeat calls are free.
const executableCache = new Map<string, Promise<string>>();
function ensureExecutable(bundledPath: string): Promise<string> {
  let cached = executableCache.get(bundledPath);
  if (!cached) {
    cached = (async () => {
      const target = path.join(tmpdir(), path.basename(bundledPath));
      try {
        const info = await stat(target);
        if (info.mode & 0o111) return target;
      } catch {
        // Not there yet -- fall through to copy it.
      }
      await copyFile(bundledPath, target);
      await chmod(target, 0o755);
      return target;
    })();
    executableCache.set(bundledPath, cached);
  }
  return cached;
}

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MAX_VIDEO_DURATION_SECONDS = 20;
export const MAX_VIDEO_LONG_EDGE = 1920;

export class VideoTooLargeError extends Error {}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

interface FfprobeStream {
  codec_type: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

async function probeVideo(filePath: string): Promise<ProbeResult> {
  const ffprobePath = await ensureExecutable(bundledFfprobePath);
  const stdout = await run(ffprobePath, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout) as {
    streams: FfprobeStream[];
    format?: { duration?: string };
  };
  const videoStream = data.streams.find((s) => s.codec_type === "video");
  const audioStream = data.streams.find((s) => s.codec_type === "audio");
  if (!videoStream || !videoStream.width || !videoStream.height) {
    throw new Error("No video stream found");
  }

  let width = videoStream.width;
  let height = videoStream.height;

  // The Display Matrix side-data `rotation` field is what ffmpeg's own
  // auto-rotate filter insertion actually reads -- the legacy `tags.rotate`
  // string can report the inverse angle for the same file, confirmed
  // empirically (a 90deg side-data rotation showed up as tags.rotate="270").
  const sideDataRotation = videoStream.side_data_list?.find(
    (sd) => typeof sd.rotation === "number",
  )?.rotation;
  const rotateTag = videoStream.tags?.rotate ? parseInt(videoStream.tags.rotate, 10) : undefined;
  const rotation = sideDataRotation ?? rotateTag ?? 0;
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  if (normalizedRotation === 90 || normalizedRotation === 270) {
    [width, height] = [height, width];
  }

  const duration = parseFloat(data.format?.duration ?? videoStream.duration ?? "0");

  return { width, height, duration, hasAudio: !!audioStream };
}

export interface VideoOverlayOptions {
  crop?: CropRect;
  topColor: string;
  bottomColor: string;
  altText: string;
}

export async function applyVideoBrandOverlay(
  input: Buffer,
  opts: VideoOverlayOptions,
): Promise<Buffer> {
  const workDir = await mkdtemp(path.join(tmpdir(), "spd-video-"));
  const inputPath = path.join(workDir, "input.mp4");
  const topPngPath = path.join(workDir, "top.png");
  const bottomPngPath = path.join(workDir, "bottom.png");
  const outputPath = path.join(workDir, "output.mp4");

  try {
    await writeFile(inputPath, input);

    const probe = await probeVideo(inputPath);

    if (probe.duration > MAX_VIDEO_DURATION_SECONDS) {
      throw new VideoTooLargeError(
        `Video is ${probe.duration.toFixed(1)}s, max is ${MAX_VIDEO_DURATION_SECONDS}s`,
      );
    }
    if (Math.max(probe.width, probe.height) > MAX_VIDEO_LONG_EDGE) {
      throw new VideoTooLargeError(
        `Video is ${probe.width}x${probe.height}, long edge max is ${MAX_VIDEO_LONG_EDGE}px`,
      );
    }

    let width = probe.width;
    let height = probe.height;
    let cropFilter = "";

    if (opts.crop) {
      const left = Math.round(opts.crop.left);
      const top = Math.round(opts.crop.top);
      const cropWidth = Math.round(opts.crop.width);
      const cropHeight = Math.round(opts.crop.height);
      cropFilter = `crop=${cropWidth}:${cropHeight}:${left}:${top}`;
      width = cropWidth;
      height = cropHeight;
    }

    const shorterEdge = Math.min(width, height);
    const pad = Math.round(shorterEdge * PAD_RATIO);
    const fontSize = Math.round(shorterEdge * FONT_SIZE_RATIO);
    const boxWidth = width - pad * 2;
    const boxHeight = Math.round(fontSize * BOX_HEIGHT_RATIO);

    const [topPng, bottomPng] = await Promise.all([
      renderChromeLine(CHROME.topLeft, opts.topColor, fontSize, boxWidth, boxHeight),
      renderChromeLine(CHROME.bottomLeft, opts.bottomColor, fontSize, boxWidth, boxHeight),
    ]);
    await Promise.all([writeFile(topPngPath, topPng), writeFile(bottomPngPath, bottomPng)]);

    const filterParts: string[] = [];
    if (cropFilter) {
      filterParts.push(`[0:v]${cropFilter}[cropped]`);
      filterParts.push(`[cropped][1:v]overlay=${pad}:${pad}[tmp]`);
    } else {
      filterParts.push(`[0:v][1:v]overlay=${pad}:${pad}[tmp]`);
    }
    filterParts.push(`[tmp][2:v]overlay=${pad}:${height - pad - boxHeight}[outv]`);

    const args = [
      "-y",
      "-i",
      inputPath,
      "-i",
      topPngPath,
      "-i",
      bottomPngPath,
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[outv]",
    ];
    if (probe.hasAudio) {
      args.push("-map", "0:a?", "-c:a", "copy");
    }
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-metadata",
      `comment=${opts.altText}`,
      outputPath,
    );

    const ffmpegPath = await ensureExecutable(bundledFfmpegPath);
    await run(ffmpegPath, args);

    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
