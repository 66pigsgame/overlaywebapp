import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { applyBrandOverlay, type CropRect } from "@/lib/overlay";

export const runtime = "nodejs";
export const maxDuration = 60;

interface OverlayRequestBody {
  blobUrl: string;
  topColor: string;
  bottomColor: string;
  dateStamp: string; // YYYYMMDD, for the embedded alt text
  timestamp: string; // YYYYMMDDHHMM, for the filename
  crop?: CropRect;
}

export async function POST(req: Request) {
  const body = (await req.json()) as OverlayRequestBody;

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
      return NextResponse.json({ error: "Could not fetch uploaded image" }, { status: 400 });
    }
    const input = Buffer.from(await sourceRes.arrayBuffer());

    const output = await applyBrandOverlay(input, {
      crop: body.crop,
      topColor: body.topColor,
      bottomColor: body.bottomColor,
      altText: `sax playing dog brand photo from ${body.dateStamp}`,
    });

    return new NextResponse(new Uint8Array(output), {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${body.timestamp}_Branded_photo.png"`,
      },
    });
  } finally {
    await del(body.blobUrl).catch(() => {});
  }
}
