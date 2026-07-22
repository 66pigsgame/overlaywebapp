import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // ffmpeg-static's binary is a single fixed (non-platform-segmented)
  // file written by its own postinstall step, so it traces on its own --
  // this is just extra insurance for the video route.
  outputFileTracingIncludes: {
    "/api/video-overlay": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
