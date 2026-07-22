import satori from "satori";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { LETTER_SPACING_EM } from "./geometry";

let fontDataPromise: Promise<Buffer> | null = null;
function getFont(): Promise<Buffer> {
  if (!fontDataPromise) {
    fontDataPromise = fs.readFile(
      path.join(process.cwd(), "public/fonts/IBMPlexMono-Regular.ttf"),
    );
  }
  return fontDataPromise;
}

/** Renders one uppercase IBM Plex Mono line to a transparent PNG buffer via satori. */
export async function renderChromeLine(
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
