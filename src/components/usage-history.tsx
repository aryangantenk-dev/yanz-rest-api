"use client";

import Link from "next/link";
import { useId, useState } from "react";

/** Satu permintaan di riwayat pemakaian (dari /api/auth/history atau /api/admin/userusage). */
export type HistoryRow = { at: string; path: string; status: number; ms: number };

const stamp = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const took = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} detik` : `${ms} ms`);
const failed = (r: HistoryRow) => r.status >= 400;

/**
 * Daftar permintaan terakhir, dari yang paling baru: endpoint, waktu, lama proses, dan kode status.
 * Menampilkan `page` baris dulu; sisanya dibuka dengan tombol di bawah daftar.
 */
export function HistoryList({ rows, page = 20, docsLinks = true }: { rows: HistoryRow[]; page?: number; docsLinks?: boolean }) {
  const [count, setCount] = useState(page);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const id = useId();
  const bad = rows.filter(failed).length;
  // Saringan hanya berlaku selama masih ada baris gagal; kalau tidak, daftar kembali penuh.
  const filtering = onlyFailed && bad > 0;
  const list = filtering ? rows.filter(failed) : rows;
  const shown = list.slice(0, count);
  const rest = list.length - shown.length;

  return (
    <div>
      {bad > 0 && (
        <label htmlFor={id} className="flex min-h-11 w-fit cursor-pointer items-center gap-2 text-sm">
          <input id={id} type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} className="h-4 w-4" />
          <span className="tnum">Hanya yang gagal ({bad})</span>
        </label>
      )}
      <ol>
        {shown.map((r, i) => {
          const [cat, ...tail] = r.path.split("/");
          const slug = tail.join("/");
          const name = `/api/${r.path}`;
          return (
            <li key={`${r.at}-${i}`} className="flex items-start justify-between gap-3 border-t border-line py-2.5 first:border-t-0">
              <div className="min-w-0">
                {docsLinks && cat && slug ? (
                  <Link href={`/docs/${cat}#${cat}-${slug}`} className="wrap-anywhere font-mono text-sm text-fg hover:underline">
                    {name}
                  </Link>
                ) : (
                  <span className="wrap-anywhere font-mono text-sm text-fg">{name}</span>
                )}
                <span className="tnum mt-0.5 block text-sm text-muted">
                  <time dateTime={r.at}>{stamp(r.at)}</time>
                  <span aria-hidden> · </span>
                  <span className="sr-only">, </span>
                  {took(r.ms)}
                </span>
              </div>
              <span className={`tnum shrink-0 border px-1.5 py-0.5 font-mono text-xs font-semibold ${failed(r) ? "border-danger text-danger" : "border-control text-muted"}`}>
                {r.status} {failed(r) ? "Gagal" : "Berhasil"}
              </span>
            </li>
          );
        })}
      </ol>
      {rest > 0 && (
        <button type="button" onClick={() => setCount((n) => n + page)} className="btn btn-secondary mt-3 w-full sm:w-auto">
          <span className="tnum">Tampilkan {Math.min(page, rest)} lagi</span>
        </button>
      )}
    </div>
  );
}
