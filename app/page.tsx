"use client";

import { useCallback, useState, type ChangeEvent } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { upload } from "@vercel/blob/client";
import { PALETTE } from "@/lib/colors";

type Status = "idle" | "uploading" | "processing" | "done" | "error";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cropEnabled, setCropEnabled] = useState(true);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [color, setColor] = useState<string>(PALETTE[4].hex);
  const [status, setStatus] = useState<Status>("idle");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
    setResultUrl(null);
    setStatus("idle");
    setErrorMsg(null);
  }

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  async function onSubmit() {
    if (!file) return;
    setErrorMsg(null);
    try {
      setStatus("uploading");
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/blob-upload",
        multipart: true,
      });

      setStatus("processing");
      const res = await fetch("/api/overlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          color,
          crop:
            cropEnabled && croppedAreaPixels
              ? {
                  left: croppedAreaPixels.x,
                  top: croppedAreaPixels.y,
                  width: croppedAreaPixels.width,
                  height: croppedAreaPixels.height,
                }
              : undefined,
        }),
      });

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      const outBlob = await res.blob();
      setResultUrl(URL.createObjectURL(outBlob));
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  const busy = status === "uploading" || status === "processing";

  return (
    <main className="min-h-screen bg-[#f1ece1] px-4 py-8 text-[#16140f]">
      <div className="mx-auto max-w-md space-y-6">
        <h1 className="text-center text-xs uppercase tracking-[0.14em] text-[#6f6a60]">
          Sax Playing Dog — Post Branding
        </h1>

        <label className="block w-full cursor-pointer border border-[#16140f]/30 bg-white px-4 py-3 text-center text-sm uppercase tracking-[0.1em]">
          {file ? "Choose a different photo" : "Choose photo"}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onFileChange}
          />
        </label>

        {previewUrl && (
          <>
            <label className="flex items-center justify-between text-sm">
              <span>Crop to Instagram post (4:5)</span>
              <input
                type="checkbox"
                checked={cropEnabled}
                onChange={(e) => setCropEnabled(e.target.checked)}
              />
            </label>

            {cropEnabled ? (
              <div className="relative h-[60vh] w-full bg-black/5">
                <Cropper
                  image={previewUrl}
                  crop={crop}
                  zoom={zoom}
                  aspect={4 / 5}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={onCropComplete}
                />
              </div>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Selected photo preview" className="w-full" />
            )}
          </>
        )}

        <div>
          <p className="mb-2 text-sm uppercase tracking-[0.1em] text-[#6f6a60]">
            Text color
          </p>
          <div className="grid grid-cols-3 gap-2">
            {PALETTE.map((c) => (
              <button
                key={c.hex}
                type="button"
                onClick={() => setColor(c.hex)}
                className={`flex items-center gap-2 border px-2 py-2 text-left text-xs ${
                  color === c.hex ? "border-[#16140f]" : "border-[#16140f]/20"
                }`}
              >
                <span
                  className="h-4 w-4 shrink-0 rounded-full border border-black/10"
                  style={{ backgroundColor: c.hex }}
                />
                {c.name}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={onSubmit}
          disabled={!file || busy}
          className="w-full bg-[#1a1a1a] py-3 text-sm uppercase tracking-[0.14em] text-[#f1ece1] disabled:opacity-40"
        >
          {status === "uploading"
            ? "Uploading..."
            : status === "processing"
              ? "Branding..."
              : "Brand it"}
        </button>

        {errorMsg && <p className="text-center text-sm text-red-700">{errorMsg}</p>}

        {resultUrl && (
          <div className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={resultUrl} alt="Branded result" className="w-full" />
            <a
              href={resultUrl}
              download="sax-playing-dog.png"
              className="block w-full bg-[#d9a441] py-3 text-center text-sm uppercase tracking-[0.14em] text-[#16140f]"
            >
              Download full quality
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
