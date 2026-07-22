import Link from "next/link";

export default function ModeSelect() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f1ece1] px-4 text-[#16140f]">
      <div className="w-full max-w-xs space-y-4">
        <h1 className="text-center text-xs uppercase tracking-[0.14em] text-[#6f6a60]">
          Sax Playing Dog — Post Branding
        </h1>
        <Link
          href="/photo"
          className="block w-full bg-[#1a1a1a] py-4 text-center text-sm uppercase tracking-[0.14em] text-[#f1ece1]"
        >
          Photo
        </Link>
        <Link
          href="/video"
          className="block w-full bg-[#1a1a1a] py-4 text-center text-sm uppercase tracking-[0.14em] text-[#f1ece1]"
        >
          Video
        </Link>
      </div>
    </main>
  );
}
