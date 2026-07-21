import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { applyBrandOverlay, type CropRect } from "@/lib/overlay";

export const runtime = "nodejs";
export const maxDuration = 60;

interface OverlayRequestBody {
  blobUrl: string;
  color: string;
  crop?: CropRect;
}

export async function POST(req: Request) {
  const body = (await req.json()) as OverlayRequestBody;

  if (!body.blobUrl || !body.color) {
    return NextResponse.json({ error: "Missing blobUrl or color" }, { status: 400 });
  }

  try {
    const sourceRes = await fetch(body.blobUrl);
    if (!sourceRes.ok) {
      return NextResponse.json({ error: "Could not fetch uploaded image" }, { status: 400 });
    }
    const input = Buffer.from(await sourceRes.arrayBuffer());

    const output = await applyBrandOverlay(input, { crop: body.crop, color: body.color });

    return new NextResponse(new Uint8Array(output), {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": 'attachment; filename="sax-playing-dog.png"',
      },
    });
  } finally {
    await del(body.blobUrl).catch(() => {});
  }
}
