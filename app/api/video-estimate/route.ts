import { NextResponse } from "next/server";
import {
  estimateEncodeTimes,
  VideoTooLargeError,
  type CropRect,
} from "@/lib/video-overlay";

export const runtime = "nodejs";
export const maxDuration = 60;

interface EstimateRequestBody {
  blobUrl: string;
  crop?: CropRect;
}

// Does NOT delete the source blob -- unlike /api/video-overlay, this is a
// preliminary step and the real encode still needs to fetch the same blob
// afterward.
export async function POST(req: Request) {
  const body = (await req.json()) as EstimateRequestBody;

  if (!body.blobUrl) {
    return NextResponse.json({ error: "Missing blobUrl" }, { status: 400 });
  }

  try {
    const sourceRes = await fetch(body.blobUrl);
    if (!sourceRes.ok) {
      return NextResponse.json({ error: "Could not fetch uploaded video" }, { status: 400 });
    }
    const input = Buffer.from(await sourceRes.arrayBuffer());

    const result = await estimateEncodeTimes(input, {
      crop: body.crop,
      // Colors don't affect encode speed; placeholders are fine since this
      // output is discarded, only timing is measured.
      topColor: "#000000",
      bottomColor: "#000000",
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof VideoTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Estimate failed" },
      { status: 500 },
    );
  }
}
