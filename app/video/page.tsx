"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Cropper, { type Area, type MediaSize, type Size } from "react-easy-crop";
import { upload } from "@vercel/blob/client";
import { PALETTE } from "@/lib/colors";
import { ChromeOverlayPreview } from "@/app/chrome-overlay-preview";
import { QUALITY_PRESETS, QUALITY_KEYS, DEFAULT_QUALITY, type QualityKey } from "@/lib/video-quality";

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

function QualityPicker({
  value,
  onChange,
}: {
  value: QualityKey;
  onChange: (key: QualityKey) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm uppercase tracking-[0.1em] text-[#6f6a60]">
        Quality (try Maximum first, step down only if it times out)
      </p>
      <div className="grid grid-cols-2 gap-2">
        {QUALITY_KEYS.map((key) => {
          const preset = QUALITY_PRESETS[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              className={`border px-3 py-2 text-left text-xs ${
                value === key ? "border-[#16140f]" : "border-[#16140f]/20"
              }`}
            >
              <div className="uppercase tracking-[0.1em]">{preset.label}</div>
              <div className="mt-0.5 text-[#6f6a60]">{preset.description}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
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

export default function VideoPage() {
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
  const [quality, setQuality] = useState<QualityKey>(DEFAULT_QUALITY);
  const [status, setStatus] = useState<Status>("idle");
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultFilename, setResultFilename] = useState<string>("Branded_video.mp4");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [previewVideoSize, setPreviewVideoSize] = useState<Size | null>(null);

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
    setPreviewVideoSize(null);
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
    const video = previewVideoRef.current;
    if (!video) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setPreviewVideoSize({ width, height });
    });
    observer.observe(video);
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
      const res = await fetch("/api/video-overlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          topColor,
          bottomColor,
          quality,
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
        if (res.status === 504) {
          throw new Error(
            "Processing timed out (over 60s). Try a lower quality tier, or a shorter/smaller video.",
          );
        }
        // A non-OK response might not be JSON at all (e.g. a platform-level
        // error page for a 502/503), so parse defensively rather than
        // assuming res.json() will succeed.
        let message = `Server returned ${res.status}`;
        try {
          const errJson = (await res.json()) as { error?: string };
          if (errJson.error) message = errJson.error;
        } catch {
          // Not JSON -- keep the generic status-based message.
        }
        throw new Error(message);
      }

      const json = (await res.json()) as { url?: string };
      if (!json.url) {
        throw new Error("Server did not return a result URL");
      }

      const outBlob = await (await fetch(json.url)).blob();
      setResultBlob(outBlob);
      setResultUrl(URL.createObjectURL(outBlob));
      setResultFilename(`${timestamp}_Branded_video.mp4`);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function onSaveToPhotos() {
    if (!resultBlob) return;
    const shareFile = new File([resultBlob], resultFilename, { type: "video/mp4" });

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
          Sax Playing Dog — Video Branding
        </h1>

        <label className="block w-full cursor-pointer border border-[#16140f]/30 bg-white px-4 py-3 text-center text-sm uppercase tracking-[0.1em]">
          {file ? "Choose a different video" : "Choose video"}
          <input
            type="file"
            accept="video/*"
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
                  key={previewUrl}
                  video={previewUrl}
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
                <video
                  ref={previewVideoRef}
                  src={previewUrl}
                  className="w-full"
                  autoPlay
                  loop
                  muted
                  playsInline
                />
                {previewVideoSize && (
                  <ChromeOverlayPreview
                    width={previewVideoSize.width}
                    height={previewVideoSize.height}
                    topColor={topColor}
                    bottomColor={bottomColor}
                  />
                )}
              </div>
            )}
          </>
        )}

        <QualityPicker value={quality} onChange={setQuality} />
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
            <video src={resultUrl} className="w-full" controls playsInline />
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
