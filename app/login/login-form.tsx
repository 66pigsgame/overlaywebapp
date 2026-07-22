"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(false);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) {
      router.replace(params.get("next") || "/");
      router.refresh();
    } else {
      setError(true);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f1ece1] px-6">
      <form onSubmit={onSubmit} className="w-full max-w-xs space-y-4">
        <h1 className="text-center text-sm uppercase tracking-[0.14em] text-[#16140f]">
          Overlay Webapp
        </h1>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full border border-[#16140f]/30 bg-white px-4 py-3 text-base text-[#16140f]"
        />
        {error && (
          <p className="text-center text-sm text-red-700">Wrong password.</p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-[#1a1a1a] py-3 text-sm uppercase tracking-[0.14em] text-[#f1ece1] disabled:opacity-50"
        >
          {loading ? "..." : "Enter"}
        </button>
      </form>
    </main>
  );
}
