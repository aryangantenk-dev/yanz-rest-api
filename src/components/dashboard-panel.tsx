"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { refreshAuth, type AuthUser } from "./auth-client";
import { ReferralCard } from "./rewards";
import { ApiBlockNotice } from "./api-block-notice";
import { Avatar } from "./avatar";
import { ArrowIcon, ClockIcon, KeyIcon, RefreshIcon } from "./icons";
import { MemberGate, PageHead } from "./member-gate";
import { HistoryList, type HistoryRow } from "./usage-history";

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

/** Paket yang sedang berlaku untuk akun ini (dari /api/auth/usage). */
type PlanInfo = { id: string; name: string; daily: number; perMinute: number; paid: boolean; expires_at: string | null; /** Tanpa kuota harian: akun admin (id "admin") atau paket tanpa batas. */ unlimited?: boolean; /** Saldo limit tambahan. */ extra?: number };

/** Jeda pembaruan otomatis. Saat gagal, jedanya digandakan sampai paling lama POLL_MAX_MS. */
const POLL_MS = 10_000;
const POLL_MAX_MS = 60_000;
/** Jarak minimum antara dua pembaruan yang dipicu oleh kembalinya fokus ke tab. */
const WAKE_GAP_MS = 2_000;
const AUTO_KEY = "yanz:dash-auto";
const readAuto = () => {
  try {
    return window.localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
};
const nf = new Intl.NumberFormat("id-ID");
const fmt = (n: number) => nf.format(n);

/** "2026-11-10" -> tanggal pada tengah hari UTC, supaya format tanggalnya tidak bergeser oleh zona waktu browser. */
const dayDate = (day: string) => new Date(`${day}T12:00:00Z`);
const dayShort = (day: string) => dayDate(day).toLocaleDateString("id-ID", { day: "numeric", month: "short", timeZone: "UTC" });
const dayLong = (day: string) => dayDate(day).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const dayNum = (day: string) => String(Number(day.slice(8, 10)));
const moment = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const failedText = (errors: number) => (errors > 0 ? `${fmt(errors)} gagal` : "Tidak ada yang gagal");

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

/**
 * Halaman riwayat: permintaan terakhir yang memakai API key akun ini. Dimuat saat halaman dibuka,
 * saat tombol Perbarui ditekan, dan saat tab ini kembali terlihat.
 */
function History() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [kept, setKept] = useState(200);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [at, setAt] = useState("");
  const alive = useRef(true);
  const lastTry = useRef(0);

  const load = useCallback(async () => {
    lastTry.current = Date.now();
    try {
      const r = await fetch("/api/auth/history", { cache: "no-store", credentials: "same-origin" });
      const body = (await r.json().catch(() => ({}))) as { history?: HistoryRow[]; kept?: number; error?: string };
      if (!alive.current) return;
      if (r.status === 401) {
        void refreshAuth();
        return;
      }
      if (!r.ok || !Array.isArray(body.history)) {
        setError(body.error ?? "Riwayat belum bisa dimuat.");
        return;
      }
      setRows(body.history);
      if (body.kept) setKept(body.kept);
      setError("");
      setAt(new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
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
    const wake = () => {
      if (document.visibilityState === "visible" && Date.now() - lastTry.current >= WAKE_GAP_MS) void load();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", wake);
    };
  }, [load]);

  const refresh = () => {
    setBusy(true);
    void load();
  };

  return (
    <div className="space-y-6">
      <PageHead title="Riwayat" lead={`Sampai ${fmt(kept)} permintaan terakhir yang memakai API key kamu, dari yang paling baru.`}>
        <button type="button" onClick={refresh} disabled={busy} className="btn btn-secondary">
          <RefreshIcon className={busy ? "spin" : ""} />
          {busy ? "Memuat…" : "Perbarui"}
        </button>
      </PageHead>

      <section aria-labelledby="dash-riwayat" className="border border-line bg-card p-4 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="dash-riwayat" className="font-mono text-lg font-bold">
            Permintaan terakhir
          </h2>
          <p className="tnum text-sm text-muted" role="status">
            {at ? `Dimuat pukul ${at}` : ""}
          </p>
        </div>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">Permintaan yang ditolak sebelum diproses (kuota habis, batas per menit, API key diblokir) tidak tercatat.</p>
        <div className="mt-3">
          {error && (
            <div className="mb-3 flex flex-col gap-3 border border-danger p-3 sm:flex-row sm:items-center sm:justify-between" role="alert">
              <p className="font-medium text-danger">{rows ? `${error} Daftar di bawah mungkin sudah tertinggal.` : error}</p>
              <button type="button" onClick={refresh} disabled={busy} className="btn btn-secondary shrink-0">
                Coba lagi
              </button>
            </div>
          )}
          {!rows && !error && <div className="h-40 animate-pulse bg-subtle" aria-hidden />}
          {rows && rows.length === 0 && (
            <div>
              <p className="text-muted">Belum ada riwayat. Permintaan berikutnya yang memakai API key kamu akan muncul di sini.</p>
              <Link href="/docs" className="btn btn-primary mt-4 w-full sm:w-auto">
                Coba endpoint pertama
                <ArrowIcon />
              </Link>
            </div>
          )}
          {rows && rows.length > 0 && <HistoryList rows={rows} />}
        </div>
      </section>
    </div>
  );
}

function Stats({ user }: { user: AuthUser }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [at, setAt] = useState<string>("");
  // Stats hanya dirender di browser (setelah sesi dimuat), jadi aman membaca localStorage di sini.
  const [auto, setAuto] = useState(readAuto);
  /** Pembaruan otomatis terakhir gagal: angka di layar mungkin sudah tertinggal. */
  const [stale, setStale] = useState(false);
  /** Jumlah pemuatan yang berhasil; angka baru disorot hanya setelah pemuatan pertama. */
  const [loads, setLoads] = useState(0);
  /** Hanya pembaruan manual yang diumumkan ke pembaca layar, supaya tidak berbunyi tiap beberapa detik. */
  const [announce, setAnnounce] = useState("");
  const alive = useRef(true);
  const running = useRef<Promise<void> | null>(null);
  const failures = useRef(0);
  const lastTry = useRef(0);

  const run = useCallback(async (silent: boolean) => {
    lastTry.current = Date.now();
    const failed = (message: string) => {
      failures.current += 1;
      // Pembaruan otomatis yang gagal tidak menimpa layar dengan pesan galat; cukup tandai datanya tertinggal.
      if (silent) setStale(true);
      else setError(message);
    };
    try {
      const r = await fetch("/api/auth/usage", { cache: "no-store", credentials: "same-origin" });
      const body = (await r.json().catch(() => ({}))) as { usage?: Usage; limit?: number; plan?: PlanInfo; error?: string };
      if (!alive.current) return;
      if (r.status === 401) {
        // Sesi berakhir: muat ulang keadaan login supaya ajakan login yang tampil.
        void refreshAuth();
        return;
      }
      if (!r.ok || !body.usage) {
        failed(body.error ?? "Statistik belum bisa dimuat. Coba lagi.");
        return;
      }
      failures.current = 0;
      const time = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setUsage(body.usage);
      setLimit(body.limit ?? null);
      setPlan(body.plan ?? null);
      setError(null);
      setStale(false);
      setAt(time);
      setLoads((n) => n + 1);
      if (!silent) setAnnounce(`Statistik diperbarui pukul ${time}`);
    } catch {
      if (alive.current) failed("Tidak dapat terhubung ke server. Periksa koneksimu, lalu coba lagi.");
    }
  }, []);

  /** Satu permintaan pada satu waktu. Pembaruan otomatis menumpang pada yang sedang berjalan; yang manual mengantre sesudahnya. */
  const load = useCallback(
    (silent = false) => {
      const prev = running.current;
      if (prev && silent) return prev;
      if (!silent) setBusy(true);
      const next: Promise<void> = (prev ?? Promise.resolve())
        .then(() => run(silent))
        .finally(() => {
          if (running.current === next) running.current = null;
          if (alive.current && !silent) setBusy(false);
        });
      running.current = next;
      return next;
    },
    [run],
  );

  useEffect(() => {
    alive.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- memuat data dari server saat halaman dibuka
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // Pembaruan otomatis: hanya selama tab terlihat, dan langsung menyusul begitu tab dibuka lagi.
  useEffect(() => {
    if (!auto) return;
    let stopped = false;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (stopped || document.visibilityState !== "visible") return;
      const wait = Math.min(POLL_MS * 2 ** failures.current, POLL_MAX_MS);
      timer = window.setTimeout(() => void load(true).then(schedule), wait);
    };
    const wake = () => {
      if (document.visibilityState !== "visible") {
        window.clearTimeout(timer);
        return;
      }
      if (Date.now() - lastTry.current < WAKE_GAP_MS) return;
      void load(true).then(schedule);
    };
    schedule();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [auto, load]);

  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    try {
      window.localStorage.setItem(AUTO_KEY, next ? "1" : "0");
    } catch {
      // Penyimpanan diblokir: pilihan hanya berlaku sampai halaman ditutup.
    }
    // Menyalakan lagi: langsung susul angka yang tertinggal.
    if (next) void load(true);
  };

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
        </div>
      </header>

      <ApiBlockNotice block={user.api_block} />

      <p role="status" className={error ? "border border-danger p-3 text-sm font-medium text-danger" : "sr-only"}>
        {error ?? announce}
      </p>

      {usage && (
        <div className="flex flex-col gap-x-4 gap-y-1 border border-line bg-card py-1 pl-4 pr-2 sm:flex-row sm:items-center sm:justify-between">
          <p id="dash-auto-info" className="flex items-center gap-2.5 py-2 text-sm text-muted sm:py-0">
            <span aria-hidden className={`block h-2.5 w-2.5 shrink-0 ${stale ? "bar-failed" : auto ? "bg-ok" : "border border-control"}`} />
            <span>
              {stale ? "Gagal memperbarui, dicoba lagi otomatis. " : auto ? `Diperbarui otomatis tiap ${POLL_MS / 1000} detik. ` : "Pembaruan otomatis dijeda. "}
              <span className="tnum whitespace-nowrap">Terakhir pukul {at}</span>
            </span>
          </p>
          <button type="button" role="switch" aria-checked={auto} aria-describedby="dash-auto-info" onClick={toggleAuto} className="flex min-h-11 shrink-0 cursor-pointer items-center justify-between gap-3 px-2 text-sm font-semibold hover:bg-subtle">
            Perbarui otomatis
            <span aria-hidden className={`flex h-6 w-11 shrink-0 items-center border p-0.5 transition-colors duration-150 ${auto ? "border-[var(--accent-edge)] bg-accent" : "border-control bg-bg"}`}>
              <span className={`block h-full w-[1.125rem] transition-transform duration-150 ${auto ? "translate-x-5 bg-onaccent" : "bg-muted"}`} />
            </span>
          </button>
        </div>
      )}

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
                  {/* key = nilainya: saat angka berubah elemen dibuat ulang sehingga sorotannya berjalan lagi. */}
                  <span key={t.value} className={`tnum block font-mono text-[1.75rem] font-bold leading-tight sm:text-[2rem] ${loads > 1 ? "tick" : ""}`}>
                    {fmt(t.value)}
                  </span>
                  <span className="tnum mt-1 block text-sm text-muted">{t.note}</span>
                </dd>
              </div>
            ))}
          </dl>

          {plan?.unlimited && plan.id !== "admin" && (
            <section aria-labelledby="dash-paket" className="border border-line bg-card p-4 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 id="dash-paket" className="font-mono text-lg font-bold">
                    Paket {plan.name}
                  </h2>
                  <p className="tnum mt-1 text-sm text-muted">
                    {plan.expires_at ? `Aktif sampai ${new Date(plan.expires_at).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}. ` : ""}
                    Tanpa kuota harian. <strong className="font-mono font-semibold text-fg">{fmt(usage.today)}</strong> permintaan hari ini.
                  </p>
                  {(plan.extra ?? 0) > 0 && <p className="tnum mt-1 text-sm text-muted">Limit tambahan {fmt(plan.extra ?? 0)} permintaan tersimpan, dan tidak terpakai selama paket ini aktif.</p>}
                </div>
                <Link href="/paket" className="btn btn-secondary shrink-0">
                  Perpanjang paket
                  <ArrowIcon />
                </Link>
              </div>
            </section>
          )}

          {plan?.unlimited && plan.id === "admin" && (
            <section aria-labelledby="dash-paket" className="border border-line bg-card p-4 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 id="dash-paket" className="font-mono text-lg font-bold">
                    Akun admin
                  </h2>
                  <p className="tnum mt-1 text-sm text-muted">
                    Tanpa kuota harian. <strong className="font-mono font-semibold text-fg">{fmt(usage.today)}</strong> permintaan hari ini.
                  </p>
                </div>
                <Link href="/admin" className="btn btn-secondary shrink-0">
                  Buka panel admin
                  <ArrowIcon />
                </Link>
              </div>
            </section>
          )}

          {plan && !plan.unlimited && (
            <section aria-labelledby="dash-paket" className="border border-line bg-card p-4 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h2 id="dash-paket" className="font-mono text-lg font-bold">
                    Paket {plan.name}
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    {plan.paid && plan.expires_at ? `Aktif sampai ${new Date(plan.expires_at).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}. ` : ""}
                    Kuota terisi lagi setiap pukul 00.00 WIB.
                  </p>
                </div>
                <Link href="/paket" className="btn btn-secondary shrink-0">
                  {plan.paid ? "Paket dan limit" : "Lihat paket"}
                  <ArrowIcon />
                </Link>
              </div>
              <p className="tnum mt-4 text-sm">
                <strong className="font-mono text-base font-semibold">{fmt(usage.today)}</strong> dari {fmt(plan.daily)} permintaan terpakai hari ini
                {usage.today >= plan.daily ? ((plan.extra ?? 0) > 0 ? ". Kuota hari ini habis; permintaan berikutnya memotong limit tambahan." : ". Kuota hari ini habis.") : `, sisa ${fmt(plan.daily - usage.today)}.`}
              </p>
              <div className="mt-2 h-2 bg-subtle" role="progressbar" aria-label="Kuota harian terpakai" aria-valuemin={0} aria-valuemax={plan.daily} aria-valuenow={Math.min(usage.today, plan.daily)}>
                <span className={`block h-full ${usage.today >= plan.daily ? "bg-danger" : "bg-accent"}`} style={{ width: `${Math.min(100, (usage.today / Math.max(1, plan.daily)) * 100)}%` }} />
              </div>
              <p className="tnum mt-3 text-sm">
                Limit tambahan: <strong className="font-mono font-semibold">{fmt(plan.extra ?? 0)}</strong> permintaan
                <span className="text-muted">{(plan.extra ?? 0) > 0 ? ". Dipakai setelah kuota harian habis, dan tidak hangus." : ". Beli di halaman Paket bila kuota harian kurang."}</span>
              </p>
            </section>
          )}

          {usage.total === 0 ? (
            <section aria-labelledby="dash-kosong" className="border border-control bg-card p-5 sm:p-8">
              <h2 id="dash-kosong" className="font-mono text-xl font-bold">
                Belum ada permintaan yang tercatat
              </h2>
              <p className="mt-2 max-w-[60ch] text-muted">Statistik mulai dihitung dari permintaan berikutnya yang memakai API key kamu. Coba satu endpoint di dokumentasi; angkanya akan muncul di sini dengan sendirinya.</p>
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
                        <dd className="tnum font-medium">
                          {fmt(limit)} per menit {plan?.paid || plan?.unlimited ? "per akun" : "per IP"}
                        </dd>
                      </div>
                    )}
                  </dl>
                </section>
              </div>
            </>
          )}

          {/* Riwayat dan API key punya halaman sendiri; di sini cukup jalan pintasnya. */}
          <nav aria-label="Halaman lain" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Link href="/dashboard/riwayat" className="group flex items-center gap-3 border border-line bg-card p-4 transition-colors duration-150 hover:border-control">
              <ClockIcon className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold group-hover:underline">Riwayat permintaan</span>
                <span className="block text-sm text-muted">Endpoint, waktu, dan kode status tiap permintaan.</span>
              </span>
              <ArrowIcon />
            </Link>
            <Link href="/dashboard/api-key" className="group flex items-center gap-3 border border-line bg-card p-4 transition-colors duration-150 hover:border-control">
              <KeyIcon className="h-[18px] w-[18px] shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold group-hover:underline">API key</span>
                <span className="block text-sm text-muted">Lihat, salin, atau ganti API key kamu.</span>
              </span>
              <ArrowIcon />
            </Link>
          </nav>
        </>
      )}
    </div>
  );
}

const GUEST = "Kamu belum login, login dahulu untuk mengecek statistik API key kamu.";

/** Halaman /dashboard: ringkasan pemakaian. */
export function DashboardPanel({ authEnabled }: { authEnabled: boolean }) {
  return (
    <MemberGate authEnabled={authEnabled} title="Dashboard" path="/dashboard" guest={GUEST} off="Login belum diaktifkan di server ini, jadi statistik per API key belum dicatat.">
      {(user) => <Stats user={user} />}
    </MemberGate>
  );
}

/** Halaman /dashboard/riwayat. */
export function HistoryPanel({ authEnabled }: { authEnabled: boolean }) {
  return (
    <MemberGate authEnabled={authEnabled} title="Riwayat" path="/dashboard/riwayat" guest="Kamu belum login, login dahulu untuk melihat riwayat permintaan API key kamu." off="Login belum diaktifkan di server ini, jadi riwayat per API key belum dicatat.">
      {() => <History />}
    </MemberGate>
  );
}

/** Halaman /dashboard/undang. */
export function ReferralPanel({ authEnabled }: { authEnabled: boolean }) {
  return (
    <MemberGate authEnabled={authEnabled} title="Undang teman" path="/dashboard/undang" guest="Kamu belum login, login dahulu untuk mendapat tautan undanganmu.">
      {() => (
        <div className="space-y-6">
          <PageHead title="Undang teman" lead="Ajak teman memakai yanz.api lewat tautanmu, dan dapatkan limit tambahan dari setiap pembelian mereka." />
          <ReferralCard />
        </div>
      )}
    </MemberGate>
  );
}
