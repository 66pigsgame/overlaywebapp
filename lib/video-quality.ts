export interface QualityPreset {
  label: string;
  description: string;
  crf: number;
  preset: string;
}

// Lower crf = higher quality/bitrate; slower preset = better compression
// efficiency at a given crf, at the cost of encode time. Ordered from
// highest quality/slowest to lowest quality/fastest so a user hitting the
// Hobby plan's 60s function timeout on a longer/higher-res clip has clear
// steps down to try.
export const QUALITY_PRESETS = {
  maximum: { label: "Maximum", description: "Closest to source quality, slowest", crf: 16, preset: "slow" },
  high: { label: "High", description: "Very close to source, faster", crf: 18, preset: "medium" },
  balanced: { label: "Balanced", description: "Good quality, faster still", crf: 20, preset: "fast" },
  fast: { label: "Fast", description: "Fastest, use if others time out", crf: 23, preset: "veryfast" },
} as const satisfies Record<string, QualityPreset>;

export type QualityKey = keyof typeof QUALITY_PRESETS;

export const QUALITY_KEYS = Object.keys(QUALITY_PRESETS) as QualityKey[];

export const DEFAULT_QUALITY: QualityKey = "maximum";

export function isQualityKey(value: unknown): value is QualityKey {
  return typeof value === "string" && value in QUALITY_PRESETS;
}
