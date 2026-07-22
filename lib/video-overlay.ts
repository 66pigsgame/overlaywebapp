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
import {
  QUALITY_PRESETS,
  QUALITY_KEYS,
  DEFAULT_QUALITY,
  type QualityKey,
} from "./video-quality";

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

// Vercel Hobby's function duration is hard-capped at 60s; this is the target
// ceiling for the actual encode step, leaving headroom for blob fetch, probe,
// calibration, PNG rendering, and the upload of the result.
export const SAFE_ENCODE_BUDGET_SECONDS = 45;

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

interface PreparedEncode {
  workDir: string;
  inputPath: string;
  topPngPath: string;
  bottomPngPath: string;
  filterComplex: string;
  duration: number;
  hasAudio: boolean;
}

export interface VideoOverlayOptions {
  crop?: CropRect;
  topColor: string;
  bottomColor: string;
  altText: string;
  quality?: QualityKey;
}

// Shared setup for both the real encode and the calibration pass: writes the
// input, probes it, computes crop/pad/font geometry, renders the two chrome
// PNGs, and builds the filter graph string. Both callers own workDir cleanup.
async function prepareEncode(
  input: Buffer,
  opts: { crop?: CropRect; topColor: string; bottomColor: string },
): Promise<PreparedEncode> {
  const workDir = await mkdtemp(path.join(tmpdir(), "spd-video-"));
  const inputPath = path.join(workDir, "input.mp4");
  const topPngPath = path.join(workDir, "top.png");
  const bottomPngPath = path.join(workDir, "bottom.png");

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

  return {
    workDir,
    inputPath,
    topPngPath,
    bottomPngPath,
    filterComplex: filterParts.join(";"),
    duration: probe.duration,
    hasAudio: probe.hasAudio,
  };
}

function buildFfmpegArgs(
  prepared: PreparedEncode,
  encode: { crf: number; preset: string },
  outputPath: string,
  altText: string,
  inputDurationLimit?: number,
): string[] {
  const args: string[] = ["-y"];
  if (inputDurationLimit !== undefined) {
    args.push("-t", String(inputDurationLimit));
  }
  args.push(
    "-i",
    prepared.inputPath,
    "-i",
    prepared.topPngPath,
    "-i",
    prepared.bottomPngPath,
    "-filter_complex",
    prepared.filterComplex,
    "-map",
    "[outv]",
  );
  if (prepared.hasAudio) {
    // Map only the first audio stream (not `0:a?`, which pulls in every
    // audio-typed stream) and always transcode to AAC instead of stream
    // copy -- some sources (confirmed with a Mac Photos export) carry a
    // second audio track whose codec has no valid MP4 tag when copied,
    // which fails the whole mux ("Could not find tag for codec ... not
    // currently supported in container"). AAC is always MP4-safe and is
    // what Instagram expects anyway.
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    encode.preset,
    "-crf",
    String(encode.crf),
    "-pix_fmt",
    "yuv420p",
    "-metadata",
    `comment=${altText}`,
    outputPath,
  );
  return args;
}

export async function applyVideoBrandOverlay(
  input: Buffer,
  opts: VideoOverlayOptions,
): Promise<Buffer> {
  const prepared = await prepareEncode(input, opts);
  try {
    const outputPath = path.join(prepared.workDir, "output.mp4");
    const { crf, preset } = QUALITY_PRESETS[opts.quality ?? DEFAULT_QUALITY];
    const args = buildFfmpegArgs(prepared, { crf, preset }, outputPath, opts.altText);

    const ffmpegPath = await resolveFfmpeg();
    await run(ffmpegPath, args);

    return await readFile(outputPath);
  } finally {
    await rm(prepared.workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Rough, deliberately conservative multipliers of encode time relative to
// the "balanced" tier's "fast" preset, which is what calibration actually
// measures. Real x264 preset speed ratios vary by resolution/content/CPU,
// so these are ballpark community-known figures rounded toward "slower than
// typical" -- an estimate that's a bit too pessimistic just recommends a
// safer tier than strictly necessary; one that's too optimistic risks
// recommending a tier that still times out.
const RELATIVE_SPEED_VS_BALANCED: Record<QualityKey, number> = {
  maximum: 2.6,
  high: 1.5,
  balanced: 1.0,
  fast: 0.75,
};

const CALIBRATION_QUALITY: QualityKey = "balanced";

export interface EncodeEstimate {
  estimates: Record<QualityKey, number>;
  fitsBudget: Record<QualityKey, boolean>;
  recommended: QualityKey;
}

export async function estimateEncodeTimes(
  input: Buffer,
  opts: { crop?: CropRect; topColor: string; bottomColor: string },
): Promise<EncodeEstimate> {
  const prepared = await prepareEncode(input, opts);
  try {
    const sampleDuration = Math.max(0.5, Math.min(2, prepared.duration * 0.3));
    const outputPath = path.join(prepared.workDir, "calibration.mp4");
    const { crf, preset } = QUALITY_PRESETS[CALIBRATION_QUALITY];
    const args = buildFfmpegArgs(
      prepared,
      { crf, preset },
      outputPath,
      "calibration",
      sampleDuration,
    );

    const ffmpegPath = await resolveFfmpeg();
    const start = Date.now();
    await run(ffmpegPath, args);
    const elapsedSeconds = (Date.now() - start) / 1000;

    const secondsPerVideoSecond = elapsedSeconds / sampleDuration;

    const estimates = {} as Record<QualityKey, number>;
    const fitsBudget = {} as Record<QualityKey, boolean>;
    for (const key of QUALITY_KEYS) {
      const estimate =
        secondsPerVideoSecond * RELATIVE_SPEED_VS_BALANCED[key] * prepared.duration;
      estimates[key] = estimate;
      fitsBudget[key] = estimate <= SAFE_ENCODE_BUDGET_SECONDS;
    }
    const recommended = QUALITY_KEYS.find((key) => fitsBudget[key]) ?? "fast";

    return { estimates, fitsBudget, recommended };
  } finally {
    await rm(prepared.workDir, { recursive: true, force: true }).catch(() => {});
  }
}
