"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { refreshAuth } from "./auth-client";
import { CopyButton } from "./client-utils";

const OFFLINE = "Tidak dapat terhubung ke server. Periksa koneksimu, lalu coba lagi.";
const nf = new Intl.NumberFormat("id-ID");
const fmt = (n: number) => nf.format(n);
const dateTime = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

async function send<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  try {
    const r = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: OFFLINE } as T & { error?: string } };
  }
}

type RedeemAnswer = { message?: string; confirm?: boolean };

/** Formulir penukaran kode hadiah di halaman /paket. `onDone` dipanggil setelah kode berhasil ditukar. */
export function RedeemForm({ signedIn, needsUsername, loginHref, onDone }: { signedIn: boolean; needsUsername: boolean; loginHref: string; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  /** Kode yang menunggu persetujuan karena akan mengganti paket yang masih aktif. */
  const [pending, setPending] = useState("");
  const alive = useRef(true);
  const id = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function submit(confirm: boolean) {
    const value = code.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    setDone("");
    const r = await send<RedeemAnswer>("/api/paket/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: value, confirm }),
    });
    if (!alive.current) return;
    setBusy(false);
    if (r.status === 401) void refreshAuth();
    if (r.ok) {
      setPending("");
      setCode("");
      setDone(r.body.message ?? "Kode berhasil ditukar.");
      onDone();
      return;
    }
    setPending(r.body.confirm ? value : "");
    setError(r.body.error ?? "Kode belum bisa ditukar. Coba lagi.");
  }

  return (
    <section aria-labelledby="paket-kode" className="border border-line bg-card p-5 sm:p-6">
      <h2 id="paket-kode" className="font-mono text-xl font-bold">
        Punya kode?
      </h2>
      <p className="mt-1 max-w-[65ch] text-muted">Kode hadiah berisi paket, limit tambahan, atau keduanya. Tiap kode bisa ditukar satu kali per akun.</p>

      {!signedIn ? (
        <Link href={loginHref} className="btn btn-secondary mt-4 w-full sm:w-auto">
          Masuk untuk menukar kode
        </Link>
      ) : needsUsername ? (
        <Link href="/akun?next=/paket" className="btn btn-secondary mt-4 w-full sm:w-auto">
          Pilih username dulu
        </Link>
      ) : (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <label htmlFor={`${id}-code`} className="block text-sm font-medium">
            Kode
          </label>
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <input
              id={`${id}-code`}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, "").slice(0, 32));
                setPending("");
                setError("");
              }}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
              className="field font-mono sm:max-w-xs"
            />
            {!pending && (
              <button type="submit" disabled={busy || code.trim().length < 4} className="btn btn-primary shrink-0">
                {busy ? "Menukar…" : "Tukar kode"}
              </button>
            )}
          </div>
          <p id={`${id}-error`} role="alert" className={error ? "mt-2 max-w-[65ch] text-sm font-medium text-danger" : "sr-only"}>
            {error}
          </p>
          {pending && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button type="button" onClick={() => void submit(true)} disabled={busy} className="btn btn-danger">
                {busy ? "Menukar…" : "Ganti paket dan tukar kode"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPending("");
                  setError("");
                }}
                disabled={busy}
                className="btn btn-secondary"
              >
                Batal
              </button>
            </div>
          )}
        </form>
      )}
      <p role="status" className={done ? "mt-3 border border-[var(--accent-edge)] p-3 font-medium" : "sr-only"}>
        {done}
      </p>
    </section>
  );
}

type Referral = { code: string; link: string; percent: number; earned: number; invited: number; buyers: number; rewards: { at: string; amount: number }[] };

/** Kartu referral di /dashboard/undang: tautan undangan milik akun ini dan hasilnya. */
export function ReferralCard() {
  const [data, setData] = useState<Referral | null>(null);
  const [error, setError] = useState("");
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let on = true;
    void send<{ referral?: Referral }>("/api/auth/referral").then((r) => {
      if (!on) return;
      if (r.ok && r.body.referral) {
        setData(r.body.referral);
        setError("");
      } else {
        setError(r.body.error ?? "Tautan referral belum bisa dimuat.");
      }
    });
    return () => {
      on = false;
    };
  }, [tries]);

  return (
    <section aria-labelledby="dash-referral" className="border border-line bg-card p-4 sm:p-6">
      <h2 id="dash-referral" className="font-mono text-lg font-bold">
        Tautan undanganmu
      </h2>
      {data ? (
        <>
          <p className="mt-1 max-w-[65ch] text-muted">
            Bagikan tautan ini. Setiap kali orang yang mendaftar lewat tautanmu membeli paket atau limit, kamu mendapat limit tambahan senilai {fmt(data.percent)}% dari pembeliannya. Contoh: pembelian Rp10.000 memberimu{" "}
            {fmt(Math.floor((10_000 * data.percent) / 100))} limit.
          </p>
          <div className="mt-3 flex items-stretch border border-control bg-bg">
            <code className="wrap-anywhere min-w-0 flex-1 self-center px-3 py-2 font-mono text-sm text-fg">{data.link}</code>
            <CopyButton text={data.link} />
          </div>
          <dl className="tnum mt-4 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-muted">Mendaftar</dt>
              <dd className="font-mono text-lg font-semibold">{fmt(data.invited)}</dd>
            </div>
            <div>
              <dt className="text-muted">Sudah membeli</dt>
              <dd className="font-mono text-lg font-semibold">{fmt(data.buyers)}</dd>
            </div>
            <div>
              <dt className="text-muted">Limit didapat</dt>
              <dd className="font-mono text-lg font-semibold">{fmt(data.earned)}</dd>
            </div>
          </dl>
          {data.rewards.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-semibold">Hadiah terakhir</h3>
              <ul className="tnum mt-1 divide-y divide-line text-sm">
                {data.rewards.map((r, i) => (
                  <li key={`${r.at}-${i}`} className="flex justify-between gap-3 py-1.5">
                    <span className="text-muted">{dateTime(r.at)}</span>
                    <span className="font-medium">+{fmt(r.amount)} limit</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : error ? (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <p className="font-medium text-danger">{error}</p>
          <button
            type="button"
            onClick={() => {
              setError("");
              setTries((n) => n + 1);
            }}
            className="btn btn-secondary shrink-0"
          >
            Coba lagi
          </button>
        </div>
      ) : (
        <div className="mt-3 h-24 animate-pulse bg-subtle" aria-hidden />
      )}
    </section>
  );
}
