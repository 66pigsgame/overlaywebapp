import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // ffprobe-static's binary path is segmented by platform/arch
  // (bin/linux/x64/ffprobe), resolved dynamically via os.platform()/
  // os.arch() at runtime -- Next's file tracer doesn't reliably follow
  // that on Vercel's build, so it has to be included explicitly.
  // ffmpeg-static's path isn't platform-segmented (a single fixed file
  // written by its own postinstall step) and traces fine on its own,
  // but is listed here too for resilience.
  outputFileTracingIncludes: {
    "/api/video-overlay": [
      "./node_modules/ffprobe-static/bin/linux/x64/ffprobe",
      "./node_modules/ffmpeg-static/ffmpeg",
    ],
  },
};

export default nextConfig;
