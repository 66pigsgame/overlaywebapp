"use client";

import { IBM_Plex_Mono } from "next/font/google";
import type { CSSProperties } from "react";
import { CHROME } from "@/lib/colors";
import { PAD_RATIO, FONT_SIZE_RATIO, LETTER_SPACING_EM, BOX_HEIGHT_RATIO } from "@/lib/geometry";

const mono = IBM_Plex_Mono({ weight: "400", subsets: ["latin"] });

export function ChromeOverlayPreview({
  width,
  height,
  color,
}: {
  width: number;
  height: number;
  color: string;
}) {
  if (!width || !height) return null;

  const shorterEdge = Math.min(width, height);
  const pad = shorterEdge * PAD_RATIO;
  const fontSize = shorterEdge * FONT_SIZE_RATIO;
  const boxHeight = fontSize * BOX_HEIGHT_RATIO;

  const lineStyle = (top: number): CSSProperties => ({
    position: "absolute",
    left: pad,
    top,
    height: boxHeight,
    display: "flex",
    alignItems: "center",
    color,
    fontSize,
    letterSpacing: `${fontSize * LETTER_SPACING_EM}px`,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  });

  return (
    <div
      className={mono.className}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      <span style={lineStyle(pad)}>{CHROME.topLeft}</span>
      <span style={lineStyle(height - pad - boxHeight)}>{CHROME.bottomLeft}</span>
    </div>
  );
}
