"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Cropper, { type Area, type MediaSize, type Size } from "react-easy-crop";
import { upload } from "@vercel/blob/client";
import { PALETTE } from "@/lib/colors";
import { ChromeOverlayPreview } from "./chrome-overlay-preview";

type Status = "idle" | "uploading" | "processing" | "done" | "error";

const MIN_CROP_WIDTH = 1080;
const MIN_CROP_HEIGHT = 1350;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function buildStamps(d: Date) {
  const dateStamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const timestamp = `${dateStamp}${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return { dateStamp, timestamp };
}

function ColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm uppercase tracking-[0.1em] text-[#6f6a60]">{label}</p>
      <div className="grid grid-cols-3 gap-2">
        {PALETTE.map((c) => (
          <button
            key={c.hex}
            type="button"
            onClick={() => onChange(c.hex)}
            className={`flex items-center gap-2 border px-2 py-2 text-left text-xs ${
              value === c.hex ? "border-[#16140f]" : "border-[#16140f]/20"
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
  );
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cropEnabled, setCropEnabled] = useState(true);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [maxZoom, setMaxZoom] = useState(3);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [cropBoxSize, setCropBoxSize] = useState<Size | null>(null);
  const [topColor, setTopColor] = useState<string>(PALETTE[4].hex);
  const [bottomColor, setBottomColor] = useState<string>(PALETTE[4].hex);
  const [status, setStatus] = useState<Status>("idle");
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultFilename, setResultFilename] = useState<string>("Branded_photo.png");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const previewImgRef = useRef<HTMLImageElement>(null);
  const [previewImgSize, setPreviewImgSize] = useState<Size | null>(null);

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setMaxZoom(3);
    setCroppedAreaPixels(null);
    setCropBoxSize(null);
    setPreviewImgSize(null);
    setResultBlob(null);
    setResultUrl(null);
    setStatus("idle");
    setErrorMsg(null);
  }

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const onMediaLoaded = useCallback((mediaSize: MediaSize) => {
    const byWidth = mediaSize.naturalWidth / MIN_CROP_WIDTH;
    const byHeight = mediaSize.naturalHeight / MIN_CROP_HEIGHT;
    setMaxZoom(Math.max(1, Math.min(3, byWidth, byHeight)));
  }, []);

  useEffect(() => {
    if (cropEnabled) return;
    const img = previewImgRef.current;
    if (!img) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setPreviewImgSize({ width, height });
    });
    observer.observe(img);
    return () => observer.disconnect();
  }, [cropEnabled, previewUrl]);

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
      const { dateStamp, timestamp } = buildStamps(new Date());
      const res = await fetch("/api/overlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          topColor,
          bottomColor,
          dateStamp,
          timestamp,
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
      setResultBlob(outBlob);
      setResultUrl(URL.createObjectURL(outBlob));
      setResultFilename(`${timestamp}_Branded_photo.png`);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function onSaveToPhotos() {
    if (!resultBlob) return;
    const shareFile = new File([resultBlob], resultFilename, { type: "image/png" });

    if (
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [shareFile] })
    ) {
      try {
        await navigator.share({ files: [shareFile] });
        return;
      } catch {
        // User cancelled or share failed — fall through to download.
      }
    }

    const url = URL.createObjectURL(resultBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resultFilename;
    a.click();
    URL.revokeObjectURL(url);
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
              <div
                className="relative h-[60vh] w-full bg-black/5"
                style={{ touchAction: "none" }}
              >
                <Cropper
                  image={previewUrl}
                  crop={crop}
                  zoom={zoom}
                  minZoom={1}
                  maxZoom={maxZoom}
                  aspect={4 / 5}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={onCropComplete}
                  onCropSizeChange={setCropBoxSize}
                  onMediaLoaded={onMediaLoaded}
                />
                {cropBoxSize && (
                  <div
                    className="pointer-events-none absolute left-1/2 top-1/2"
                    style={{
                      width: cropBoxSize.width,
                      height: cropBoxSize.height,
                      transform: "translate(-50%, -50%)",
                    }}
                  >
                    <ChromeOverlayPreview
                      width={cropBoxSize.width}
                      height={cropBoxSize.height}
                      topColor={topColor}
                      bottomColor={bottomColor}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={previewImgRef}
                  src={previewUrl}
                  alt="Selected photo preview"
                  className="w-full"
                />
                {previewImgSize && (
                  <ChromeOverlayPreview
                    width={previewImgSize.width}
                    height={previewImgSize.height}
                    topColor={topColor}
                    bottomColor={bottomColor}
                  />
                )}
              </div>
            )}
          </>
        )}

        <ColorPicker label="Top line color" value={topColor} onChange={setTopColor} />
        <ColorPicker label="Bottom line color" value={bottomColor} onChange={setBottomColor} />

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
            <button
              type="button"
              onClick={onSaveToPhotos}
              className="block w-full bg-[#d9a441] py-3 text-center text-sm uppercase tracking-[0.14em] text-[#16140f]"
            >
              Save to Photos
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
