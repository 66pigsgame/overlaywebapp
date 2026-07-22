import { NextResponse } from "next/server";
import { del, put } from "@vercel/blob";
import {
  applyVideoBrandOverlay,
  VideoTooLargeError,
  type CropRect,
} from "@/lib/video-overlay";
import { isQualityKey, DEFAULT_QUALITY, type QualityKey } from "@/lib/video-quality";

export const runtime = "nodejs";
export const maxDuration = 60;

interface VideoOverlayRequestBody {
  blobUrl: string;
  topColor: string;
  bottomColor: string;
  dateStamp: string; // YYYYMMDD, for the embedded metadata comment
  timestamp: string; // YYYYMMDDHHMM, for the output filename
  crop?: CropRect;
  quality?: QualityKey;
}

export async function POST(req: Request) {
  const body = (await req.json()) as VideoOverlayRequestBody;

  if (
    !body.blobUrl ||
    !body.topColor ||
    !body.bottomColor ||
    !body.dateStamp ||
    !body.timestamp
  ) {
    return NextResponse.json(
      { error: "Missing blobUrl, topColor, bottomColor, dateStamp, or timestamp" },
      { status: 400 },
    );
  }

  try {
    const sourceRes = await fetch(body.blobUrl);
    if (!sourceRes.ok) {
      return NextResponse.json({ error: "Could not fetch uploaded video" }, { status: 400 });
    }
    const input = Buffer.from(await sourceRes.arrayBuffer());

    const quality = isQualityKey(body.quality) ? body.quality : DEFAULT_QUALITY;

    const output = await applyVideoBrandOverlay(input, {
      crop: body.crop,
      topColor: body.topColor,
      bottomColor: body.bottomColor,
      altText: `sax playing dog brand video from ${body.dateStamp}`,
      quality,
    });

    const result = await put(`${body.timestamp}_Branded_video.mp4`, output, {
      access: "public",
      addRandomSuffix: true,
      contentType: "video/mp4",
    });

    return NextResponse.json({ url: result.url });
  } catch (error) {
    if (error instanceof VideoTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Video processing failed" },
      { status: 500 },
    );
  } finally {
    await del(body.blobUrl).catch(() => {});
  }
}
