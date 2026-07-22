import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPathRaw from "ffmpeg-static";
import { CHROME } from "./colors";
import { PAD_RATIO, FONT_SIZE_RATIO, BOX_HEIGHT_RATIO } from "./geometry";
import { renderChromeLine } from "./chrome-render";

if (!ffmpegPathRaw) {
  throw new Error("ffmpeg-static did not resolve a binary path for this platform");
}
const bundledFfmpegPath: string = ffmpegPathRaw;

// Vercel's serverless packaging doesn't reliably preserve the executable
// bit on file-traced binaries, and the bundle's own directory can be
// read-only at runtime. Copy the binary into /tmp (writable) and chmod
// it there once per cold start; cached so repeat calls are free.
let executableCache: Promise<string> | null = null;
function ensureExecutable(bundledPath: string): Promise<string> {
  if (!executableCache) {
    executableCache = (async () => {
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
  }
  return executableCache;
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

// Runs ffmpeg against a file and returns its stderr text regardless of exit
// code -- stream/duration/rotation info is printed as soon as ffmpeg opens
// and analyzes the input, before any decoding happens, so this works even
// if the process is given no real work to do.
function runFfmpegStderr(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", () => resolve(stderr));
  });
}

interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

// Uses ffmpeg's own stderr analysis output instead of a separate ffprobe
// binary -- ffprobe-static ships a ~340MB all-platforms bundle that hasn't
// survived Vercel's build pipeline (confirmed via two separate failures:
// first the traced binary was missing at spawn time, then even an explicit
// outputFileTracingIncludes entry didn't make the source file exist for a
// copy). ffmpeg-static's single flat (non-platform-segmented) binary path
// has traced and run correctly in both of those attempts, so this drops
// the fragile dependency rather than patching around it again.
async function probeVideo(filePath: string): Promise<ProbeResult> {
  const ffmpegPath = await ensureExecutable(bundledFfmpegPath);
  const stderr = await runFfmpegStderr(ffmpegPath, [
    "-i",
    filePath,
    "-t",
    "0.1",
    "-f",
    "null",
    "-",
  ]);

  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durationMatch
    ? parseInt(durationMatch[1], 10) * 3600 +
      parseInt(durationMatch[2], 10) * 60 +
      parseFloat(durationMatch[3])
    : 0;

  const videoLineMatch = stderr.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  if (!videoLineMatch) {
    throw new Error(`Could not determine video dimensions from ffmpeg output:\n${stderr}`);
  }
  let width = parseInt(videoLineMatch[1], 10);
  let height = parseInt(videoLineMatch[2], 10);

  // The Display Matrix side-data rotation is what ffmpeg's own auto-rotate
  // filter insertion actually reads -- the legacy `rotate` tag can report
  // the inverse angle for the same file, confirmed empirically (a 90deg
  // side-data rotation showed up as a rotate tag of 270).
  const displayMatrixMatch = stderr.match(/displaymatrix:\s*rotation of\s*(-?[\d.]+)\s*degrees/);
  const rotateTagMatch = stderr.match(/rotate\s*:\s*(-?\d+)/);
  const rotation = displayMatrixMatch
    ? parseFloat(displayMatrixMatch[1])
    : rotateTagMatch
      ? parseInt(rotateTagMatch[1], 10)
      : 0;
  const normalizedRotation = ((Math.round(rotation) % 360) + 360) % 360;
  if (normalizedRotation === 90 || normalizedRotation === 270) {
    [width, height] = [height, width];
  }

  const hasAudio = /Stream #\d+:\d+[^\n]*: Audio:/.test(stderr);

  return { width, height, duration, hasAudio };
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
