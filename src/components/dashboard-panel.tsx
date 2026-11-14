"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { refreshAuth, useAuth, type AuthUser } from "./auth-client";
import { Avatar } from "./avatar";
import { CopyButton } from "./client-utils";
import { ArrowIcon, RefreshIcon, UserIcon } from "./icons";

type Day = { day: string; hits: number; errors: number };
type Top = { path: string; hits: number; errors: number };
type Usage = {
  today: number;
  today_errors: number;
  week: number;
  week_errors: number;
  month: number;
  month_errors: number;
  total: number;
  total_errors: number;
  first_at: string | null;
  last_at: string | null;
  endpoints: number;
  days: Day[];
  top: Top[];
};

const LOGIN_HREF = "/login?next=/dashboard";
const mask = (key: string) => `${key.slice(0, 3)}${"•".repeat(12)}${key.slice(-4)}`;
const nf = new Intl.NumberFormat("id-ID");
const fmt = (n: number) => nf.format(n);

/** "2026-11-10" -> tanggal pada tengah hari UTC, supaya format tanggalnya tidak bergeser oleh zona waktu browser. */
const dayDate = (day: string) => new Date(`${day}T12:00:00Z`);
const dayShort = (day: string) => dayDate(day).toLocaleDateString("id-ID", { day: "numeric", month: "short", timeZone: "UTC" });
const dayLong = (day: string) => dayDate(day).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const dayNum = (day: string) => String(Number(day.slice(8, 10)));
const moment = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const failedText = (errors: number) => (errors > 0 ? `${fmt(errors)} gagal` : "Tidak ada yang gagal");

/** Kerangka halaman: judul selalu sama di semua keadaan supaya halaman tidak melompat saat data tiba. */
function Shell({ children, busy = false }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <div className="border border-line bg-card p-5 sm:p-8" aria-busy={busy || undefined}>
      {children}
    </div>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true">
      <p className="sr-only" role="status">
        {label}
      </p>
      <div className="space-y-6" aria-hidden>
        <div className="h-10 w-56 animate-pulse bg-subtle" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse bg-subtle" />
          ))}
        </div>
        <div className="h-72 animate-pulse bg-subtle" />
      </div>
    </div>
  );
}

/** Diagram batang permintaan per hari. Tiap batang adalah tombol: dipilih untuk melihat rinciannya. */
function DailyChart({ days }: { days: Day[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const selected = days.find((d) => d.day === picked) ?? days[days.length - 1];
  const max = Math.max(1, ...days.map((d) => d.hits));
  // Di layar sempit hanya 7 hari terakhir yang muat dengan batang selebar jari.
  const hiddenOnMobile = Math.max(0, days.length - 7);

  return (
    <section aria-labelledby="dash-harian" className="border border-line bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="dash-harian" className="font-mono text-lg font-bold">
          Permintaan per hari
        </h2>
        <p className="text-sm text-muted">
          <span className="sm:hidden">7 hari terakhir</span>
          <span className="hidden sm:inline">{days.length} hari terakhir</span>
          <span aria-hidden> · </span>
          <span className="tnum">tertinggi {fmt(max === 1 && !days.some((d) => d.hits) ? 0 : max)} per hari</span>
        </p>
      </div>

      <div className="mt-5 flex h-44 items-stretch border-b border-control sm:gap-2" role="group" aria-label="Permintaan per hari, pilih satu hari untuk rinciannya">
        {days.map((d, i) => {
          const on = d.day === selected.day;
          const okPct = ((d.hits - d.errors) / max) * 100;
          const badPct = (d.errors / max) * 100;
          return (
            <button
              key={d.day}
              type="button"
              aria-pressed={on}
              aria-label={`${dayLong(d.day)}: ${fmt(d.hits)} permintaan, ${fmt(d.errors)} gagal`}
              onClick={() => setPicked(d.day)}
              className={`group min-w-0 flex-1 flex-col justify-end px-1 transition-colors duration-150 hover:bg-subtle sm:px-1 ${i < hiddenOnMobile ? "hidden sm:flex" : "flex"} ${on ? "bg-subtle" : ""}`}
            >
              {/* Bagian gagal bergaris, bukan hanya berbeda warna. */}
              {d.errors > 0 && <span className="bar-failed block w-full" style={{ height: `${badPct}%`, minHeight: 3 }} />}
              {d.hits - d.errors > 0 && <span className={`block w-full ${on ? "bg-ok" : "bg-accent"}`} style={{ height: `${okPct}%`, minHeight: 3 }} />}
              {d.hits === 0 && <span className="block h-px w-full bg-control" />}
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex sm:gap-2" aria-hidden>
        {days.map((d, i) => (
          <span key={d.day} className={`tnum min-w-0 flex-1 text-center font-mono text-xs ${i < hiddenOnMobile ? "hidden sm:block" : "block"} ${d.day === selected.day ? "font-bold text-fg" : "text-muted"}`}>
            {dayNum(d.day)}
          </span>
        ))}
      </div>

      <p className="mt-4 min-h-12 border border-line bg-bg px-3 py-2 text-sm sm:min-h-0" aria-live="polite">
        <strong className="font-semibold">{dayLong(selected.day)}</strong>
        <span aria-hidden> · </span>
        <span className="sr-only">: </span>
        <span className="tnum">
          {fmt(selected.hits)} permintaan, {fmt(selected.hits - selected.errors)} berhasil, {fmt(selected.errors)} gagal
        </span>
      </p>

      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 bg-accent" aria-hidden />
          Berhasil
        </li>
        <li className="flex items-center gap-2">
          <span className="bar-failed h-3 w-3" aria-hidden />
          Gagal
        </li>
        <li>Hari dihitung menurut WIB.</li>
      </ul>

      <details className="mt-3 border-t border-line">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">Lihat sebagai tabel</summary>
        <div className="overflow-x-auto pb-2">
          <table className="tnum w-full min-w-[18rem] border-collapse text-sm">
            <caption className="sr-only">Permintaan per hari</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Tanggal
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">
                  Permintaan
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Gagal
                </th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day} className="border-b border-line last:border-b-0">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {dayShort(d.day)}
                  </th>
                  <td className="py-2 pr-3 text-right font-mono">{fmt(d.hits)}</td>
                  <td className="py-2 text-right font-mono">{fmt(d.errors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function TopEndpoints({ top }: { top: Top[] }) {
  const max = Math.max(1, ...top.map((t) => t.hits));
  return (
    <section aria-labelledby="dash-endpoint" className="border border-line bg-card p-4 sm:p-6">
      <h2 id="dash-endpoint" className="font-mono text-lg font-bold">
        Endpoint paling sering dipakai
      </h2>
      <p className="mt-1 text-sm text-muted">30 hari terakhir. Pilih endpoint untuk membuka dokumentasinya.</p>
      <ol className="mt-3">
        {top.map((t, i) => {
          const [cat, ...rest] = t.path.split("/");
          const slug = rest.join("/");
          return (
            <li key={t.path} className="border-t border-line first:border-t-0">
              <Link href={`/docs/${cat}#${cat}-${slug}`} className="group block py-2.5">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="wrap-anywhere min-w-0 font-mono text-sm text-fg group-hover:underline">
                    <span className="tnum text-muted">{i + 1}.</span> /api/{t.path}
                  </span>
                  <span className="tnum shrink-0 font-mono text-sm font-semibold">
                    {fmt(t.hits)}
                    <span className="sr-only"> permintaan</span>
                  </span>
                </span>
                <span className="mt-1.5 block h-1.5 bg-subtle" aria-hidden>
                  <span className="block h-full bg-accent" style={{ width: `${Math.max(2, (t.hits / max) * 100)}%` }} />
                </span>
                {t.errors > 0 && <span className="tnum mt-1 block text-sm text-muted">{fmt(t.errors)} gagal</span>}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Stats({ user, apiKey }: { user: AuthUser; apiKey: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [at, setAt] = useState<string>("");
  const alive = useRef(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/auth/usage", { cache: "no-store", credentials: "same-origin" });
      const body = (await r.json().catch(() => ({}))) as { usage?: Usage; limit?: number; error?: string };
      if (!alive.current) return;
      if (r.status === 401) {
        // Sesi berakhir: muat ulang keadaan login supaya ajakan login yang tampil.
        void refreshAuth();
        return;
      }
      if (!r.ok || !body.usage) {
        setError(body.error ?? "Statistik belum bisa dimuat. Coba lagi.");
        return;
      }
      setUsage(body.usage);
      setLimit(body.limit ?? null);
      setError(null);
      setAt(new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }));
    } catch {
      if (alive.current) setError("Tidak dapat terhubung ke server. Periksa koneksimu, lalu coba lagi.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- memuat data dari server saat halaman dibuka
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const rate = usage && usage.month > 0 ? Math.round(((usage.month - usage.month_errors) / usage.month) * 1000) / 10 : null;
  const tiles = usage
    ? [
        { label: "Hari ini", value: usage.today, note: failedText(usage.today_errors) },
        { label: "7 hari terakhir", value: usage.week, note: failedText(usage.week_errors) },
        { label: "30 hari terakhir", value: usage.month, note: failedText(usage.month_errors) },
        { label: "Total", value: usage.total, note: usage.first_at ? `Sejak ${new Date(usage.first_at).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}` : "Belum ada permintaan" },
      ]
    : [];

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar photo={user.photo} name={user.username} className="h-16 w-16 text-2xl" />
          <div className="min-w-0">
            <h1 className="font-mono text-[2rem] font-bold leading-tight tracking-tight">Dashboard</h1>
            <p className="wrap-anywhere mt-1 text-muted">
              Statistik API key <strong className="font-mono font-semibold text-fg">@{user.username}</strong>
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button type="button" onClick={() => void load()} disabled={busy} className="btn btn-secondary">
            <RefreshIcon className={busy ? "spin" : ""} />
            {busy ? "Memuat…" : "Perbarui"}
          </button>
          <Link href="/akun" className="btn btn-secondary">
            <UserIcon />
            Kelola akun
          </Link>
        </div>
      </header>

      <p role="status" className={error ? "border border-danger p-3 text-sm font-medium text-danger" : "sr-only"}>
        {error ?? (usage && at ? `Statistik diperbarui pukul ${at}` : "")}
      </p>

      {!usage ? (
        error ? null : (
          <Skeleton label="Memuat statistik" />
        )
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {tiles.map((t) => (
              <div key={t.label} className="border border-line bg-card p-4">
                <dt className="text-sm text-muted">{t.label}</dt>
                <dd className="mt-1">
                  <span className="tnum block font-mono text-[1.75rem] font-bold leading-tight sm:text-[2rem]">{fmt(t.value)}</span>
                  <span className="tnum mt-1 block text-sm text-muted">{t.note}</span>
                </dd>
              </div>
            ))}
          </dl>

          {usage.total === 0 ? (
            <section aria-labelledby="dash-kosong" className="border border-control bg-card p-5 sm:p-8">
              <h2 id="dash-kosong" className="font-mono text-xl font-bold">
                Belum ada permintaan yang tercatat
              </h2>
              <p className="mt-2 max-w-[60ch] text-muted">Statistik mulai dihitung dari permintaan berikutnya yang memakai API key kamu. Coba satu endpoint di dokumentasi, lalu tekan Perbarui di sini.</p>
              <Link href="/docs" className="btn btn-primary mt-5 w-full sm:w-auto">
                Coba endpoint pertama
                <ArrowIcon />
              </Link>
            </section>
          ) : (
            <>
              <DailyChart days={usage.days} />
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                <div className="min-w-0 lg:col-span-7">
                  {usage.top.length > 0 ? (
                    <TopEndpoints top={usage.top} />
                  ) : (
                    <section className="border border-line bg-card p-4 sm:p-6">
                      <h2 className="font-mono text-lg font-bold">Endpoint paling sering dipakai</h2>
                      <p className="mt-2 text-muted">Tidak ada permintaan dalam 30 hari terakhir.</p>
                    </section>
                  )}
                </div>
                <section aria-labelledby="dash-ringkas" className="min-w-0 border border-line bg-card p-4 sm:p-6 lg:col-span-5">
                  <h2 id="dash-ringkas" className="font-mono text-lg font-bold">
                    Ringkasan
                  </h2>
                  <dl className="mt-3">
                    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2.5 first:border-t-0">
                      <dt className="text-muted">Tingkat berhasil (30 hari)</dt>
                      <dd className="tnum shrink-0 font-mono font-semibold">{rate === null ? "–" : `${rate.toLocaleString("id-ID")}%`}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2.5">
                      <dt className="text-muted">Endpoint berbeda (30 hari)</dt>
                      <dd className="tnum shrink-0 font-mono font-semibold">{fmt(usage.endpoints)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2.5">
                      <dt className="text-muted">Total gagal</dt>
                      <dd className="tnum shrink-0 font-mono font-semibold">{fmt(usage.total_errors)}</dd>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-t border-line py-2.5">
                      <dt className="text-muted">Terakhir dipakai</dt>
                      <dd className="tnum font-medium">{usage.last_at ? moment(usage.last_at) : "–"}</dd>
                    </div>
                    {limit !== null && (
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-t border-line py-2.5">
                        <dt className="text-muted">Batas permintaan</dt>
                        <dd className="tnum font-medium">{fmt(limit)} per menit per IP</dd>
                      </div>
                    )}
                  </dl>
                </section>
              </div>
            </>
          )}

          <section aria-labelledby="dash-key" className="border border-line bg-card p-4 sm:p-6">
            <h2 id="dash-key" className="font-mono text-lg font-bold">
              API key kamu
            </h2>
            <div className="mt-3 flex items-stretch border border-control bg-bg">
              <code className="wrap-anywhere tnum min-w-0 flex-1 self-center px-3 py-2 font-mono text-base text-fg" aria-label="API key, disembunyikan">
                {mask(apiKey)}
              </code>
              <CopyButton text={apiKey} />
            </div>
            <p className="mt-2 text-sm text-muted">
              Statistik dicatat per akun, jadi angkanya tetap ada setelah API key diganti. Lihat atau ganti key di halaman{" "}
              <Link href="/akun" className="link font-medium text-fg">
                Akun
              </Link>
              .
            </p>
          </section>
        </>
      )}
    </div>
  );
}

export function DashboardPanel({ authEnabled }: { authEnabled: boolean }) {
  const auth = useAuth(authEnabled);

  if (!authEnabled) {
    return (
      <Shell>
        <h1 className="font-mono text-2xl font-bold tracking-tight sm:text-[2rem]">Dashboard</h1>
        <p className="mt-3 max-w-[60ch] text-muted">Login belum diaktifkan di server ini, jadi statistik per API key belum dicatat.</p>
        <Link href="/docs" className="btn btn-secondary mt-6 w-full sm:w-auto">
          Buka dokumentasi
          <ArrowIcon />
        </Link>
      </Shell>
    );
  }

  if (auth.status === "loading") {
    return <Skeleton label="Memuat dashboard" />;
  }

  if (auth.status === "error" && !auth.user) {
    return (
      <Shell>
        <h1 className="font-mono text-2xl font-bold tracking-tight sm:text-[2rem]">Dashboard belum bisa dimuat</h1>
        <p role="alert" className="mt-3 text-muted">
          Server akun sedang tidak dapat dihubungi. Periksa koneksimu, lalu coba lagi.
        </p>
        <button type="button" onClick={() => void refreshAuth()} className="btn btn-primary mt-6 w-full sm:w-auto">
          Coba lagi
        </button>
      </Shell>
    );
  }

  if (!auth.user) {
    return (
      <Shell>
        <h1 className="font-mono text-2xl font-bold tracking-tight sm:text-[2rem]">Dashboard</h1>
        <p id="dash-tamu" className="mt-3 max-w-[60ch] text-lg">
          Kamu belum login, login dahulu untuk mengecek statistik API key kamu.
        </p>
        <Link href={LOGIN_HREF} className="btn btn-primary mt-6 w-full sm:w-auto">
          Login
          <ArrowIcon />
        </Link>
        <p className="mt-4 flex flex-wrap items-center gap-x-2 border-t border-line pt-2 text-muted">
          Belum punya akun?
          <Link href="/daftar?next=/dashboard" className="link inline-flex min-h-11 items-center font-semibold text-fg">
            Daftar
          </Link>
        </p>
      </Shell>
    );
  }

  if (auth.needsUsername || !auth.apiKey) {
    return (
      <Shell>
        <h1 className="font-mono text-2xl font-bold tracking-tight sm:text-[2rem]">Dashboard</h1>
        <p className="mt-3 max-w-[60ch] text-lg">Pilih username dulu. API key dan statistiknya baru aktif setelah username diisi.</p>
        <Link href="/akun?next=/dashboard" className="btn btn-primary mt-6 w-full sm:w-auto">
          Pilih username
          <ArrowIcon />
        </Link>
      </Shell>
    );
  }

  return <Stats user={auth.user} apiKey={auth.apiKey} />;
}
