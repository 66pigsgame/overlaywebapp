import sharp from "sharp";
import { CHROME } from "./colors";
import { PAD_RATIO, FONT_SIZE_RATIO, BOX_HEIGHT_RATIO } from "./geometry";
import { buildAltTextXmp } from "./xmp";
import { renderChromeLine } from "./chrome-render";

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
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
