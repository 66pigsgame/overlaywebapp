import satori from "satori";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { CHROME } from "./colors";
import { PAD_RATIO, FONT_SIZE_RATIO, LETTER_SPACING_EM, BOX_HEIGHT_RATIO } from "./geometry";
import { buildAltTextXmp } from "./xmp";

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

let fontDataPromise: Promise<Buffer> | null = null;
function getFont(): Promise<Buffer> {
  if (!fontDataPromise) {
    fontDataPromise = fs.readFile(
      path.join(process.cwd(), "public/fonts/IBMPlexMono-Regular.ttf"),
    );
  }
  return fontDataPromise;
}

async function renderChromeLine(
  text: string,
  color: string,
  fontSize: number,
  boxWidth: number,
  boxHeight: number,
): Promise<Buffer> {
  const fontData = await getFont();
  const svg = await satori(
    <div
      style={{
        width: `${boxWidth}px`,
        height: `${boxHeight}px`,
        display: "flex",
        alignItems: "center",
        color,
        fontFamily: "IBM Plex Mono",
        fontSize: `${fontSize}px`,
        fontWeight: 400,
        letterSpacing: `${fontSize * LETTER_SPACING_EM}px`,
        textTransform: "uppercase",
      }}
    >
      {text}
    </div>,
    {
      width: boxWidth,
      height: boxHeight,
      fonts: [
        { name: "IBM Plex Mono", data: fontData, weight: 400, style: "normal" },
      ],
    },
  );
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function applyBrandOverlay(
  input: Buffer,
  opts: { crop?: CropRect; topColor: string; bottomColor: string; altText: string },
): Promise<Buffer> {
  // Materialize the EXIF-auto-oriented image first so width/height below
  // always reflect the visually-correct (post-rotation) dimensions.
  const rotated = await sharp(input).rotate().toBuffer();
  const baseMeta = await sharp(rotated).metadata();

  let pipeline = sharp(rotated);
  let width = baseMeta.width!;
  let height = baseMeta.height!;

  if (opts.crop) {
    const left = Math.round(opts.crop.left);
    const top = Math.round(opts.crop.top);
    const cropWidth = Math.round(opts.crop.width);
    const cropHeight = Math.round(opts.crop.height);
    pipeline = pipeline.extract({ left, top, width: cropWidth, height: cropHeight });
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

  return pipeline
    .composite([
      { input: topPng, left: pad, top: pad },
      { input: bottomPng, left: pad, top: height - pad - boxHeight },
    ])
    .withXmp(buildAltTextXmp(opts.altText))
    .png()
    .toBuffer();
}
