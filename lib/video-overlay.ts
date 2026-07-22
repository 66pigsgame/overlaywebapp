import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { CHROME } from "./colors";
import { PAD_RATIO, FONT_SIZE_RATIO, BOX_HEIGHT_RATIO } from "./geometry";
import { renderChromeLine } from "./chrome-render";
import { QUALITY_PRESETS, DEFAULT_QUALITY, type QualityKey } from "./video-quality";

// After three separate failures getting any file-traced binary (ffprobe-static,
// then ffmpeg-static) to actually exist in the deployed function bundle on
// this project's Next 16 + Turbopack + Vercel setup, this sidesteps build-time
// bundling entirely: fetch a known-good static ffmpeg binary over HTTP into
// /tmp on first use instead. Zero dependency on Next's file tracing.
//
// Reuses the exact release the (now-removed) ffmpeg-static package itself
// downloads from, pinned to a specific version and platform/arch (Vercel's
// Node.js serverless functions run linux/x64).
const FFMPEG_DOWNLOAD_URL =
  "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz";

let ffmpegPathCache: Promise<string> | null = null;
function resolveFfmpeg(): Promise<string> {
  if (ffmpegPathCache) return ffmpegPathCache;

  ffmpegPathCache = (async () => {
    // Local dev/testing escape hatch -- point at a real local ffmpeg
    // instead of downloading a Linux binary that won't run on this machine.
    if (process.env.FFMPEG_BIN_OVERRIDE) {
      return process.env.FFMPEG_BIN_OVERRIDE;
    }

    const target = path.join(tmpdir(), "ffmpeg");
    try {
      const info = await stat(target);
      if (info.size > 0 && info.mode & 0o111) return target;
    } catch {
      // Not there yet -- fall through to download it.
    }

    const res = await fetch(FFMPEG_DOWNLOAD_URL);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download ffmpeg binary: HTTP ${res.status}`);
    }
    const { Readable } = await import("node:stream");
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
      createGunzip(),
      createWriteStream(target),
    );
    await chmod(target, 0o755);
    return target;
  })();

  return ffmpegPathCache;
}

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MAX_VIDEO_DURATION_SECONDS = 20;

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
// binary -- see the resolveFfmpeg() comment above for why no bundled
// binary is used for either tool.
async function probeVideo(filePath: string): Promise<ProbeResult> {
  const ffmpegPath = await resolveFfmpeg();
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
  quality?: QualityKey;
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
      // Map only the first audio stream (not `0:a?`, which pulls in every
      // audio-typed stream) and always transcode to AAC instead of stream
      // copy -- some sources (confirmed with a Mac Photos export) carry a
      // second audio track whose codec has no valid MP4 tag when copied,
      // which fails the whole mux ("Could not find tag for codec ... not
      // currently supported in container"). AAC is always MP4-safe and is
      // what Instagram expects anyway.
      args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k");
    }
    const { crf, preset } = QUALITY_PRESETS[opts.quality ?? DEFAULT_QUALITY];
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-metadata",
      `comment=${opts.altText}`,
      outputPath,
    );

    const ffmpegPath = await resolveFfmpeg();
    await run(ffmpegPath, args);

    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
