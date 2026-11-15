"use client";

import { useEffect, useRef, useState } from "react";

/* Bagian yang dipakai bersama oleh tab-tab panel admin. */

export const OFFLINE = "Tidak dapat terhubung ke server. Periksa koneksimu, lalu coba lagi.";

export type Answer<T> = { ok: boolean; status: number; result: T | null; error: string };

/** Panggil /api/admin/<aksi> dengan sesi login. Header penanda wajib ada; lihat catatan di rute itu. */
export async function call<T>(action: string, params: Record<string, string> = {}): Promise<Answer<T>> {
  try {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`/api/admin/${action}${qs ? `?${qs}` : ""}`, { cache: "no-store", credentials: "same-origin", headers: { "x-requested-with": "yanz-admin" } });
    const body = (await r.json().catch(() => ({}))) as { result?: T; error?: string };
    return { ok: r.ok, status: r.status, result: r.ok ? (body.result ?? null) : null, error: body.error || (r.ok ? "" : `Server menjawab ${r.status}.`) };
  } catch {
    return { ok: false, status: 0, result: null, error: OFFLINE };
  }
}

export function Badge({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "ok" | "danger" }) {
  const cls = tone === "ok" ? "border-[var(--accent-edge)] text-fg" : tone === "danger" ? "border-danger text-danger" : "border-control text-muted";
  return <span className={`inline-flex items-center border px-1.5 py-0.5 font-mono text-xs font-semibold ${cls}`}>{children}</span>;
}

/** Tombol untuk aksi yang berdampak besar: klik pertama meminta kepastian, klik kedua menjalankan. */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className = "btn btn-danger" }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; className?: string }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <button
      type="button"
      disabled={disabled}
      className={className}
      onClick={() => {
        if (timer.current) clearTimeout(timer.current);
        if (armed) {
          setArmed(false);
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), 5_000);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
