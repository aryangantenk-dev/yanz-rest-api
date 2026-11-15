"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "./auth-client";
import { ArrowIcon, RefreshIcon } from "./icons";
import { HistoryList, type HistoryRow } from "./usage-history";
import { AdminCodes } from "./admin-codes";
import { Badge, ConfirmButton, call } from "./admin-shared";

type PlanOption = { id: string; name: string; paid: boolean };
type UserRow = {
  email: string;
  username: string;
  name: string;
  provider: string;
  banned: boolean;
  is_admin?: boolean;
  created_at: string;
  last_login_at: string;
  api_key: string;
  plan?: string;
  plan_expires_at?: string | null;
  used_today?: number;
  used_total?: number;
  /** Saldo limit tambahan akun ini. */
  extra_limit?: number;
  /** Blokir API yang sedang berlaku; `api_blocked_until` null berarti selamanya. */
  api_blocked?: boolean;
  api_blocked_until?: string | null;
  api_block_reason?: string;
};
type UsageDay = { day: string; hits: number; errors: number };
type UsageTop = { path: string; hits: number; errors: number };
/** Jawaban /api/admin/userusage: ringkasan dan riwayat pemakaian satu akun. */
type UserUsageData = {
  usage: { today: number; today_errors: number; week: number; week_errors: number; month: number; month_errors: number; total: number; total_errors: number; first_at: string | null; last_at: string | null; days: UsageDay[]; top: UsageTop[] };
  history: HistoryRow[];
  kept?: number;
};
type KeyBlockRow = { email: string; username: string; api_blocked_until: string | null; api_block_reason: string; api_blocked_at: string | null };
type KeyBlocks = { total: number; users: KeyBlockRow[] };
type Users = { total: number; users: UserRow[] };
type OrderRow = { id: string; email: string; username: string; plan: string; days?: number; qty?: number; amount: number; total: number | null; status: string; gateway_ref: string; created_at: string; paid_at: string | null };
type Orders = { paid: number; paid_amount: number; orders: OrderRow[] };
type Ban = { ip: string; reason: string; created_at: string | null };
type Bans = { total: number; bans: Ban[] };
/** Endpoint untuk pilihan blokir API: `id` berisi "kategori/slug". */
type EndpointOption = { id: string; title: string; category: string };
type CategoryOption = { id: string; name: string };
type ApiBlockRow = { path: string; reason: string; created_at: string | null; scope?: "endpoint" | "category"; title?: string; exists?: boolean };
type ApiBlocks = { total: number; blocks: ApiBlockRow[] };
type Payment = { plan_days: number; limit_price?: number; limit_step?: number; api_key_set: boolean; webhook_secret_set: boolean; fee_bearer: string; gateway_reachable: boolean; webhook_url: string };
type Notice = { tone: "ok" | "danger"; text: string };
type Tab = "akun" | "pesanan" | "kode" | "blokir" | "kunci" | "api" | "pembayaran";

/** Pilihan lama blokir API; nilainya dikirim apa adanya sebagai parameter `duration`. */
const DURATIONS: { v: string; label: string }[] = [
  { v: "1h", label: "1 jam" },
  { v: "6h", label: "6 jam" },
  { v: "1d", label: "1 hari" },
  { v: "3d", label: "3 hari" },
  { v: "7d", label: "7 hari" },
  { v: "30d", label: "30 hari" },
  { v: "permanent", label: "Selamanya" },
  { v: "custom", label: "Atur sendiri" },
];
const UNITS: { v: "m" | "h" | "d"; label: string; minutes: number }[] = [
  { v: "m", label: "menit", minutes: 1 },
  { v: "h", label: "jam", minutes: 60 },
  { v: "d", label: "hari", minutes: 1440 },
];
const MAX_BLOCK_MINUTES = 3650 * 1440;

const STATUS_LABEL: Record<string, string> = { pending: "Menunggu pembayaran", paid: "Lunas", expired: "Kedaluwarsa", canceled: "Dibatalkan", failed: "Gagal dibuat" };
const TABS: { id: Tab; label: string }[] = [
  { id: "akun", label: "Akun" },
  { id: "pesanan", label: "Pesanan" },
  { id: "kode", label: "Kode" },
  { id: "blokir", label: "Blokir IP" },
  { id: "kunci", label: "Blokir API" },
  { id: "api", label: "Blokir endpoint" },
  { id: "pembayaran", label: "Pembayaran" },
];

const nf = new Intl.NumberFormat("id-ID");
const fmt = (n: number | undefined | null) => nf.format(Number(n) || 0);
const rupiah = (n: number | undefined | null) => `Rp${fmt(n)}`;
const moment = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-");
const dateLong = (iso: string) => new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });

/** Riwayat pemakaian API satu akun, dibuka dari kartu akunnya: ringkasan, endpoint terbanyak, per hari, dan permintaan terakhir. */
function UserUsage({ email }: { email: string }) {
  const [data, setData] = useState<UserUsageData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let off = false;
    void (async () => {
      const r = await call<UserUsageData>("userusage", { email });
      if (off) return;
      setBusy(false);
      if (r.result) {
        setData(r.result);
        setError("");
      } else setError(r.error || "Riwayat belum bisa dimuat.");
    })();
    return () => {
      off = true;
    };
  }, [email, tick]);

  const u = data?.usage;
  const totals = u
    ? [
        { label: "Hari ini", hits: u.today, errors: u.today_errors },
        { label: "7 hari", hits: u.week, errors: u.week_errors },
        { label: "30 hari", hits: u.month, errors: u.month_errors },
        { label: "Total", hits: u.total, errors: u.total_errors },
      ]
    : [];
  const dayShort = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("id-ID", { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <div className="mt-4 border-t border-line pt-4" aria-busy={busy || undefined}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="font-mono text-base font-bold">Riwayat penggunaan API</h3>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setTick((n) => n + 1);
          }}
          className="btn btn-secondary"
        >
          {busy ? "Memuat…" : "Muat ulang"}
        </button>
      </div>
      {error && (
        <p className="mt-3 border border-danger p-3 font-medium text-danger" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <div className="mt-3 h-40 animate-pulse bg-subtle" aria-hidden />}
      {data && u && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {totals.map((t) => (
              <div key={t.label} className="border border-line bg-bg p-3">
                <dt className="text-sm text-muted">{t.label}</dt>
                <dd className="tnum mt-1">
                  <span className="block font-mono text-xl font-bold leading-tight">{fmt(t.hits)}</span>
                  <span className="block text-sm text-muted">{t.errors > 0 ? `${fmt(t.errors)} gagal` : "Tidak ada yang gagal"}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="tnum mt-2 text-sm text-muted">
            {u.first_at ? `Permintaan pertama ${moment(u.first_at)}, terakhir ${moment(u.last_at)}.` : "Akun ini belum pernah memakai API."}
          </p>

          {u.top.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold">Endpoint terbanyak (30 hari)</h4>
              <ol className="tnum mt-1">
                {u.top.map((t) => (
                  <li key={t.path} className="flex items-baseline justify-between gap-3 border-t border-line py-2 first:border-t-0">
                    <span className="wrap-anywhere min-w-0 font-mono text-sm">/api/{t.path}</span>
                    <span className="shrink-0 text-sm">
                      <span className="font-mono font-semibold">{fmt(t.hits)}</span>
                      {t.errors > 0 ? <span className="text-muted">, {fmt(t.errors)} gagal</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {u.days.some((d) => d.hits > 0) && (
            <details className="mt-3 border-t border-line">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">Permintaan per hari ({u.days.length} hari terakhir)</summary>
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
                    {[...u.days].reverse().map((d) => (
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
          )}

          <div className="mt-4">
            <h4 className="text-sm font-semibold">Permintaan terakhir</h4>
            {data.history.length === 0 ? (
              <p className="mt-1 text-sm text-muted">Belum ada permintaan di riwayat akun ini.</p>
            ) : (
              <>
                <p className="tnum mt-1 text-sm text-muted">Sampai {fmt(data.kept ?? 200)} permintaan terakhir tiap akun. Permintaan yang ditolak sebelum diproses tidak tercatat.</p>
                <HistoryList rows={data.history} page={10} docsLinks={false} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header className="mb-8">
        <h1 className="font-mono text-[2rem] font-bold leading-tight tracking-tight sm:text-[2.5rem]">Admin</h1>
        <p className="mt-3 max-w-[60ch] text-lg text-muted">Akun pengguna, pesanan paket, blokir IP, blokir API pengguna, blokir endpoint, dan status pembayaran.</p>
      </header>
      {children}
    </div>
  );
}

export function AdminPanel({
  authEnabled,
  plans,
  planDays,
  endpoints = [],
  categories = [],
}: {
  authEnabled: boolean;
  plans: PlanOption[];
  planDays: number;
  /** Semua endpoint dan kategorinya, untuk pilihan di tab Blokir endpoint. */
  endpoints?: EndpointOption[];
  categories?: CategoryOption[];
}) {
  const auth = useAuth(authEnabled);
  const isAdmin = auth.user?.admin === true;
  const [tab, setTab] = useState<Tab>("akun");
  const [users, setUsers] = useState<Users | null>(null);
  const [orders, setOrders] = useState<Orders | null>(null);
  const [bans, setBans] = useState<Bans | null>(null);
  const [apiBlocks, setApiBlocks] = useState<ApiBlocks | null>(null);
  const [keyBlocks, setKeyBlocks] = useState<KeyBlocks | null>(null);
  const [kbWho, setKbWho] = useState("");
  const [kbDuration, setKbDuration] = useState("1d");
  const [kbAmount, setKbAmount] = useState("2");
  const [kbUnit, setKbUnit] = useState<"m" | "h" | "d">("h");
  const [kbReason, setKbReason] = useState("");
  const [apiPick, setApiPick] = useState("");
  const [apiFilter, setApiFilter] = useState("");
  const [apiReason, setApiReason] = useState("");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Tab, string>>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  /** Email akun yang riwayat penggunaannya sedang dibuka di tab Akun. */
  const [viewing, setViewing] = useState<string | null>(null);
  const [planPick, setPlanPick] = useState(plans.find((p) => p.paid)?.id ?? plans[0]?.id ?? "free");
  const [daysPick, setDaysPick] = useState(String(planDays));
  const [limitPick, setLimitPick] = useState("1000");
  const [banIp, setBanIp] = useState("");
  const [banReason, setBanReason] = useState("");
  const alive = useRef(true);
  const ids = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const [u, o, b, p, a, k] = await Promise.all([call<Users>("users"), call<Orders>("orders"), call<Bans>("bans"), call<Payment>("paket"), call<ApiBlocks>("apiblocks"), call<KeyBlocks>("keyblocks")]);
    if (!alive.current) return;
    if (u.result) setUsers(u.result);
    if (o.result) setOrders(o.result);
    if (b.result) setBans(b.result);
    if (p.result) setPayment(p.result);
    if (a.result) setApiBlocks(a.result);
    if (k.result) setKeyBlocks(k.result);
    setErrors({ akun: u.ok ? undefined : u.error, pesanan: o.ok ? undefined : o.error, blokir: b.ok ? undefined : b.error, kunci: k.ok ? undefined : k.error, api: a.ok ? undefined : a.error, pembayaran: p.ok ? undefined : p.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- memuat data dari server saat halaman dibuka
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const reload = () => {
    setLoading(true);
    void load();
  };

  /** Jalankan satu aksi, tampilkan hasilnya, lalu muat ulang daftar. */
  async function run(id: string, action: string, params: Record<string, string>, done: string): Promise<boolean> {
    setBusy(id);
    setNotice(null);
    const r = await call<{ message?: string }>(action, params);
    if (!alive.current) return false;
    setBusy(null);
    if (!r.ok) {
      setNotice({ tone: "danger", text: r.error });
      return false;
    }
    setNotice({ tone: "ok", text: done });
    setEditing(null);
    await load();
    return true;
  }

  if (!authEnabled) {
    return (
      <Frame>
        <p className="border border-control bg-card p-4 text-muted">Login belum diaktifkan di server ini, jadi panel admin belum bisa dipakai. Aksi admin tetap tersedia lewat /api/admin dengan ADMIN_KEY.</p>
      </Frame>
    );
  }
  if (auth.status === "loading") {
    return (
      <Frame>
        <div aria-busy="true">
          <p className="sr-only" role="status">
            Memeriksa akun…
          </p>
          <div className="space-y-4" aria-hidden>
            <div className="h-24 animate-pulse bg-subtle" />
            <div className="h-64 animate-pulse bg-subtle" />
          </div>
        </div>
      </Frame>
    );
  }
  if (auth.status === "error") {
    return (
      <Frame>
        <p className="border border-danger p-4 font-medium text-danger">Server akun sedang tidak dapat dihubungi. Muat ulang halaman ini sebentar lagi.</p>
      </Frame>
    );
  }
  if (!auth.user) {
    return (
      <Frame>
        <div className="border border-line bg-card p-5 sm:p-8">
          <p className="max-w-[60ch] text-muted">Halaman ini khusus akun admin. Masuk dulu dengan akun admin untuk membukanya.</p>
          <Link href="/login?next=/admin" className="btn btn-primary mt-4">
            Masuk
            <ArrowIcon />
          </Link>
        </div>
      </Frame>
    );
  }
  if (!isAdmin) {
    return (
      <Frame>
        <div className="border border-line bg-card p-5 sm:p-8">
          <p className="max-w-[60ch] text-muted">
            Akun <span className="font-mono text-fg">@{auth.user.username || auth.user.email}</span> bukan akun admin, jadi halaman ini tidak bisa dibuka.
          </p>
          <Link href="/dashboard" className="btn btn-secondary mt-4">
            Ke dashboard
          </Link>
        </div>
      </Frame>
    );
  }

  const planName = (id: string | undefined) => plans.find((p) => p.id === id)?.name ?? id ?? "-";
  const needle = query.trim().toLowerCase();
  const shown = users ? users.users.filter((u) => !needle || u.email.includes(needle) || u.username.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle)) : [];
  const pickedPlan = plans.find((p) => p.id === planPick);
  const daysOk = !pickedPlan?.paid || (/^\d{1,4}$/.test(daysPick) && Number(daysPick) >= 1 && Number(daysPick) <= 3650);
  // Angka negatif mengurangi saldo limit tambahan.
  const limitOk = /^-?\d{1,8}$/.test(limitPick) && Number(limitPick) !== 0 && Math.abs(Number(limitPick)) <= 10_000_000;
  const first = users === null && orders === null && bans === null && payment === null && apiBlocks === null && keyBlocks === null && Object.keys(errors).length === 0;

  // Tab Blokir API (pengguna): akun ditulis dengan email, atau username salah satu akun yang termuat.
  const kbTyped = kbWho.trim().toLowerCase();
  const kbEmail = /^[^\s@]+@[^\s@]+\.[a-z0-9-]{2,}$/.test(kbTyped) ? kbTyped : (users?.users.find((u) => u.username && u.username.toLowerCase() === kbTyped.replace(/^@/, ""))?.email ?? "");
  const kbTarget = users?.users.find((u) => u.email === kbEmail);
  const kbMinutes = Number(kbAmount) * (UNITS.find((x) => x.v === kbUnit)?.minutes ?? 1);
  const kbCustomOk = kbDuration !== "custom" || (/^\d{1,7}$/.test(kbAmount) && kbMinutes >= 1 && kbMinutes <= MAX_BLOCK_MINUTES);
  const kbSelf = !!kbEmail && kbEmail === auth.user.email;
  const kbProblem = !kbTyped
    ? ""
    : !kbEmail
      ? "Username itu tidak ada di daftar akun yang termuat. Isi alamat emailnya."
      : kbSelf
        ? "Kamu tidak bisa memblokir API akunmu sendiri."
        : kbTarget?.is_admin
          ? "API akun admin tidak bisa diblokir."
          : !kbCustomOk
            ? "Isi lama blokir dengan angka, paling sedikit 1 menit dan paling lama 3650 hari."
            : "";
  const kbReady = !!kbEmail && !kbProblem && kbCustomOk;
  const kbLabel = kbDuration === "custom" ? `${fmt(Number(kbAmount))} ${UNITS.find((x) => x.v === kbUnit)?.label ?? ""}` : (DURATIONS.find((d) => d.v === kbDuration)?.label ?? "").toLowerCase();

  // Tab Blokir endpoint: pilihan endpoint per kategori, disaring oleh kata yang diketik admin.
  const blockedNow = new Set(apiBlocks?.blocks.map((b) => b.path) ?? []);
  const apiNeedle = apiFilter.trim().toLowerCase();
  const apiGroups = categories
    .map((c) => {
      const all = endpoints.filter((e) => e.category === c.id);
      const whole = !apiNeedle || c.name.toLowerCase().includes(apiNeedle) || c.id.includes(apiNeedle);
      return { c, count: all.length, items: whole ? all : all.filter((e) => `${e.title} ${e.id}`.toLowerCase().includes(apiNeedle)) };
    })
    .filter((g) => g.items.length > 0);
  const apiOffered = apiGroups.reduce((n, g) => n + g.items.length, 0);
  // Pilihan yang tersaring keluar dari daftar dianggap belum dipilih.
  const apiTarget = apiGroups.some((g) => apiPick === `${g.c.id}/*` || g.items.some((e) => e.id === apiPick)) && !blockedNow.has(apiPick) ? apiPick : "";

  const stats = [
    { label: "Akun", value: users ? fmt(users.total) : "-" },
    { label: "Pesanan lunas", value: orders ? fmt(orders.paid) : "-" },
    { label: "Pendapatan paket", value: orders ? rupiah(orders.paid_amount) : "-" },
    { label: "IP diblokir", value: bans ? fmt(bans.total) : "-" },
  ];

  return (
    <Frame>
      <div className="space-y-6" aria-busy={first || loading || undefined}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            Masuk sebagai <span className="font-mono text-fg">@{auth.user.username}</span>
          </p>
          <button type="button" onClick={reload} disabled={loading || first} className="btn btn-secondary">
            <RefreshIcon />
            {loading ? "Memuat…" : "Muat ulang"}
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="border border-line bg-card p-4">
              <dt className="text-sm text-muted">{s.label}</dt>
              <dd className="tnum mt-1 font-mono text-2xl font-bold">{first ? <span className="block h-8 w-16 animate-pulse bg-subtle" aria-hidden /> : s.value}</dd>
            </div>
          ))}
        </dl>

        <p role="status" aria-live="polite" className={notice ? `border p-3 font-medium ${notice.tone === "danger" ? "border-danger text-danger" : "border-[var(--accent-edge)] bg-card text-fg"}` : "sr-only"}>
          {notice?.text}
        </p>

        <div role="tablist" aria-label="Bagian panel admin" className="flex overflow-x-auto border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${ids}-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${ids}-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`relative min-h-11 shrink-0 px-4 text-[0.9375rem] transition-colors duration-150 ${tab === t.id ? "font-semibold text-fg" : "text-muted hover:text-fg"}`}
            >
              {t.label}
              {t.id === "api" && apiBlocks && apiBlocks.total > 0 ? ` (${fmt(apiBlocks.total)})` : ""}
              {t.id === "kunci" && keyBlocks && keyBlocks.total > 0 ? ` (${fmt(keyBlocks.total)})` : ""}
              {tab === t.id && <span className="absolute inset-x-4 bottom-0 h-0.5 bg-accent" aria-hidden />}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`${ids}-panel-${tab}`} aria-labelledby={`${ids}-tab-${tab}`}>
          {errors[tab] && <p className="mb-4 border border-danger p-3 font-medium text-danger">{errors[tab]}</p>}

          {tab === "akun" && (
            <section>
              <label htmlFor={`${ids}-cari`} className="block text-sm font-medium">
                Cari akun
              </label>
              <input id={`${ids}-cari`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="username atau email" autoComplete="off" spellCheck={false} className="field mt-1 sm:max-w-sm" />
              {users && users.total > users.users.length && (
                <p className="tnum mt-2 text-sm text-muted">
                  Menampilkan {fmt(users.users.length)} akun terbaru dari {fmt(users.total)}.
                </p>
              )}
              {!users && !errors.akun && <div className="mt-4 h-40 animate-pulse bg-subtle" aria-hidden />}
              {users && shown.length === 0 && <p className="mt-4 border border-line bg-card p-4 text-muted">{needle ? "Tidak ada akun yang cocok dengan pencarian itu." : "Belum ada akun."}</p>}
              <ul className="mt-4 space-y-3">
                {shown.map((u) => {
                  const paid = !!u.plan && u.plan !== "free";
                  const self = u.email === auth.user?.email;
                  const open = editing === u.email;
                  return (
                    <li key={u.email} className="border border-line bg-card p-4">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h2 className="wrap-anywhere font-mono text-base font-bold">{u.username ? `@${u.username}` : "(belum memilih username)"}</h2>
                        {u.is_admin && <Badge tone="ok">Admin</Badge>}
                        {u.banned && <Badge tone="danger">Nonaktif</Badge>}
                        {u.api_blocked && <Badge tone="danger">API diblokir</Badge>}
                        <Badge>{planName(u.plan || "free")}</Badge>
                        {self && <span className="text-sm text-muted">akun kamu</span>}
                      </div>
                      <p className="wrap-anywhere mt-1 text-sm text-muted">{u.email}</p>
                      <dl className="tnum mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                        <div className="flex justify-between gap-3 sm:block">
                          <dt className="text-muted sm:inline">Paket: </dt>
                          <dd className="sm:inline">{paid && u.plan_expires_at ? `${planName(u.plan)} sampai ${dateLong(u.plan_expires_at)}` : planName("free")}</dd>
                        </div>
                        <div className="flex justify-between gap-3 sm:block">
                          <dt className="text-muted sm:inline">Permintaan: </dt>
                          <dd className="sm:inline">
                            {fmt(u.used_today)} hari ini, {fmt(u.used_total)} total
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3 sm:block">
                          <dt className="text-muted sm:inline">Limit tambahan: </dt>
                          <dd className="sm:inline">{fmt(u.extra_limit)}</dd>
                        </div>
                        <div className="flex justify-between gap-3 sm:block">
                          <dt className="text-muted sm:inline">Bergabung: </dt>
                          <dd className="sm:inline">
                            {moment(u.created_at)} lewat {u.provider === "google" ? "Google" : "email"}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3 sm:block">
                          <dt className="text-muted sm:inline">Terakhir masuk: </dt>
                          <dd className="sm:inline">{moment(u.last_login_at)}</dd>
                        </div>
                        <div className="flex justify-between gap-3 sm:block">
                          <dt className="text-muted sm:inline">API key: </dt>
                          <dd className="font-mono sm:inline">{u.api_key}</dd>
                        </div>
                      </dl>

                      {u.api_blocked && (
                        <p className="wrap-anywhere mt-3 text-sm text-danger">
                          API diblokir {u.api_blocked_until ? `sampai ${moment(u.api_blocked_until)}` : "selamanya"}
                          {u.api_block_reason ? `. Alasan: ${u.api_block_reason.replace(/[.\s]+$/, "")}` : ""}.
                        </p>
                      )}

                      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        <button type="button" onClick={() => setEditing(open ? null : u.email)} aria-expanded={open} className="btn btn-secondary">
                          {open ? "Batal" : "Atur paket"}
                        </button>
                        <button type="button" onClick={() => setViewing(viewing === u.email ? null : u.email)} aria-expanded={viewing === u.email} className="btn btn-secondary">
                          {viewing === u.email ? "Tutup riwayat" : "Riwayat API"}
                        </button>
                        {u.api_blocked ? (
                          <button type="button" disabled={!!busy} onClick={() => void run(`kb:${u.email}`, "keyunblock", { email: u.email }, `Blokir API ${u.email} dibuka.`)} className="btn btn-secondary">
                            {busy === `kb:${u.email}` ? "Membuka…" : "Buka blokir API"}
                          </button>
                        ) : u.is_admin || self ? null : (
                          <button
                            type="button"
                            onClick={() => {
                              setKbWho(u.email);
                              setNotice(null);
                              setTab("kunci");
                            }}
                            className="btn btn-secondary"
                          >
                            Blokir API
                          </button>
                        )}
                        {u.banned ? (
                          <button type="button" disabled={!!busy} onClick={() => void run(`ban:${u.email}`, "userunban", { email: u.email }, `Akun ${u.email} diaktifkan lagi.`)} className="btn btn-secondary">
                            {busy === `ban:${u.email}` ? "Mengaktifkan…" : "Aktifkan lagi"}
                          </button>
                        ) : u.is_admin ? null : (
                          <ConfirmButton
                            label={busy === `ban:${u.email}` ? "Menonaktifkan…" : "Nonaktifkan akun"}
                            confirmLabel="Klik lagi untuk menonaktifkan"
                            disabled={!!busy}
                            onConfirm={() => void run(`ban:${u.email}`, "userban", { email: u.email }, `Akun ${u.email} dinonaktifkan. API key-nya berhenti berfungsi paling lama satu menit lagi.`)}
                          />
                        )}
                      </div>
                      {u.is_admin && !u.banned && <p className="mt-2 text-sm text-muted">Akun admin tidak bisa dinonaktifkan dari panel ini.</p>}

                      {open && (
                        <form
                          className="mt-4 border-t border-line pt-4"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!daysOk) return;
                            const params: Record<string, string> = { email: u.email, plan: planPick };
                            if (pickedPlan?.paid) params.days = daysPick;
                            void run(`plan:${u.email}`, "setplan", params, pickedPlan?.paid ? `Paket ${pickedPlan.name} untuk ${u.email} ditambah ${daysPick} hari.` : `Akun ${u.email} dikembalikan ke paket ${planName(planPick)}.`);
                          }}
                        >
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                            <div>
                              <label htmlFor={`${ids}-plan`} className="block text-sm font-medium">
                                Paket
                              </label>
                              <select id={`${ids}-plan`} value={planPick} onChange={(e) => setPlanPick(e.target.value)} className="field mt-1">
                                {plans.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label htmlFor={`${ids}-days`} className="block text-sm font-medium">
                                Tambah masa aktif (hari)
                              </label>
                              <input
                                id={`${ids}-days`}
                                inputMode="numeric"
                                value={pickedPlan?.paid ? daysPick : ""}
                                onChange={(e) => setDaysPick(e.target.value.replace(/\D/g, "").slice(0, 4))}
                                disabled={!pickedPlan?.paid}
                                aria-invalid={!daysOk}
                                aria-describedby={`${ids}-days-help`}
                                className="field mt-1 disabled:opacity-50"
                              />
                            </div>
                            <button type="submit" disabled={!!busy || !daysOk} className="btn btn-primary">
                              {busy === `plan:${u.email}` ? "Menyimpan…" : "Simpan"}
                            </button>
                          </div>
                          <p id={`${ids}-days-help`} className={`mt-2 text-sm ${daysOk ? "text-muted" : "text-danger"}`}>
                            {pickedPlan?.paid
                              ? daysOk
                                ? "Tanpa pembayaran. Bila paket yang sama masih aktif, harinya ditambahkan ke masa aktif yang ada."
                                : "Isi jumlah hari dari 1 sampai 3650."
                              : "Paket berbayar akun ini langsung berakhir."}
                          </p>
                        </form>
                      )}

                      {open && (
                        <form
                          className="mt-4 border-t border-line pt-4"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!limitOk) return;
                            const n = Number(limitPick);
                            void run(`limit:${u.email}`, "addlimit", { email: u.email, amount: String(n) }, `Limit tambahan ${u.email} ${n > 0 ? "ditambah" : "dikurangi"} ${fmt(Math.abs(n))}.`);
                          }}
                        >
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                            <div>
                              <label htmlFor={`${ids}-limit`} className="block text-sm font-medium">
                                Tambah limit tambahan (permintaan)
                              </label>
                              <input
                                id={`${ids}-limit`}
                                inputMode="text"
                                autoComplete="off"
                                value={limitPick}
                                onChange={(e) => setLimitPick(e.target.value.replace(/[^\d-]/g, "").replace(/(?!^)-/g, "").slice(0, 9))}
                                aria-invalid={!limitOk}
                                aria-describedby={`${ids}-limit-help`}
                                className="field tnum mt-1"
                              />
                            </div>
                            <button type="submit" disabled={!!busy || !limitOk} className="btn btn-primary">
                              {busy === `limit:${u.email}` ? "Menyimpan…" : "Tambah limit"}
                            </button>
                          </div>
                          <p id={`${ids}-limit-help`} className={`tnum mt-2 text-sm ${limitOk ? "text-muted" : "text-danger"}`}>
                            {limitOk ? `Tanpa pembayaran. Saldo sekarang ${fmt(u.extra_limit)}. Isi angka negatif untuk mengurangi.` : "Isi bilangan bulat selain 0, paling banyak 10.000.000."}
                          </p>
                        </form>
                      )}

                      {viewing === u.email && <UserUsage email={u.email} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {tab === "pesanan" && (
            <section>
              {!orders && !errors.pesanan && <div className="h-40 animate-pulse bg-subtle" aria-hidden />}
              {orders && orders.orders.length === 0 && <p className="border border-line bg-card p-4 text-muted">Belum ada pesanan paket.</p>}
              {orders && orders.orders.length > 0 && (
                <div className="border border-line bg-card p-4 sm:p-6">
                  <p className="tnum text-sm text-muted">
                    {fmt(orders.orders.length)} pesanan terbaru. Lunas {fmt(orders.paid)} pesanan, total {rupiah(orders.paid_amount)} sebelum biaya QRIS.
                  </p>
                  <div className="mt-3 overflow-x-auto">
                    <table className="tnum w-full min-w-[44rem] border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-line text-left text-muted">
                          <th scope="col" className="py-2 pr-3 font-medium">Tanggal</th>
                          <th scope="col" className="py-2 pr-3 font-medium">Pesanan</th>
                          <th scope="col" className="py-2 pr-3 font-medium">Akun</th>
                          <th scope="col" className="py-2 pr-3 font-medium">Paket</th>
                          <th scope="col" className="py-2 pr-3 text-right font-medium">Nominal</th>
                          <th scope="col" className="py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.orders.map((o) => (
                          <tr key={o.id} className="border-b border-line align-top last:border-b-0">
                            <td className="py-2 pr-3">{moment(o.created_at)}</td>
                            <td className="py-2 pr-3 font-mono">{o.id}</td>
                            <td className="wrap-anywhere py-2 pr-3">{o.username ? `@${o.username}` : o.email || "(akun dihapus)"}</td>
                            <td className="py-2 pr-3">
                              {o.plan === "limit" ? `Limit tambahan ${fmt(o.qty)}` : `${planName(o.plan)}${o.days ? `, ${fmt(o.days)} hari` : ""}`}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono">{rupiah(o.amount)}</td>
                            <td className="py-2">{o.status === "paid" && o.paid_at ? `Lunas ${moment(o.paid_at)}` : (STATUS_LABEL[o.status] ?? o.status)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}

          {tab === "kode" && <AdminCodes plans={plans} />}

          {tab === "blokir" && (
            <section className="space-y-4">
              <form
                className="border border-line bg-card p-4 sm:p-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  const ip = banIp.trim().toLowerCase();
                  if (!ip) return;
                  const params: Record<string, string> = { ip };
                  if (banReason.trim()) params.reason = banReason.trim();
                  void run("ipban", "ban", params, `IP ${ip} diblokir.`).then((ok) => {
                    if (ok && alive.current) {
                      setBanIp("");
                      setBanReason("");
                    }
                  });
                }}
              >
                <h2 className="font-mono text-lg font-bold">Blokir IP secara manual</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                  <div>
                    <label htmlFor={`${ids}-ip`} className="block text-sm font-medium">
                      Alamat IP
                    </label>
                    <input id={`${ids}-ip`} value={banIp} onChange={(e) => setBanIp(e.target.value)} placeholder="1.2.3.4" autoComplete="off" spellCheck={false} maxLength={45} className="field mt-1" />
                  </div>
                  <div>
                    <label htmlFor={`${ids}-alasan`} className="block text-sm font-medium">
                      Alasan (opsional)
                    </label>
                    <input id={`${ids}-alasan`} value={banReason} onChange={(e) => setBanReason(e.target.value)} maxLength={300} autoComplete="off" className="field mt-1" />
                  </div>
                  <button type="submit" disabled={!!busy || !banIp.trim()} className="btn btn-danger">
                    {busy === "ipban" ? "Memblokir…" : "Blokir"}
                  </button>
                </div>
                <p className="mt-2 text-sm text-muted">IP yang diblokir menerima jawaban 403 untuk semua permintaan ke /api sampai blokirnya dibuka.</p>
              </form>

              {!bans && !errors.blokir && <div className="h-32 animate-pulse bg-subtle" aria-hidden />}
              {bans && bans.bans.length === 0 && <p className="border border-line bg-card p-4 text-muted">Tidak ada IP yang sedang diblokir.</p>}
              {bans && bans.bans.length > 0 && (
                <ul className="space-y-3">
                  {bans.bans.map((b) => (
                    <li key={b.ip} className="flex flex-col gap-3 border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="wrap-anywhere font-mono font-bold">{b.ip}</p>
                        <p className="wrap-anywhere mt-1 text-sm text-muted">
                          {b.reason || "Tanpa alasan"}
                          {b.created_at ? `, sejak ${moment(b.created_at)}` : ""}
                        </p>
                      </div>
                      <button type="button" disabled={!!busy} onClick={() => void run(`unban:${b.ip}`, "unban", { ip: b.ip }, `Blokir untuk ${b.ip} dibuka.`)} className="btn btn-secondary shrink-0">
                        {busy === `unban:${b.ip}` ? "Membuka…" : "Buka blokir"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "kunci" && (
            <section className="space-y-4">
              <form
                className="border border-line bg-card p-4 sm:p-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!kbReady) return;
                  const params: Record<string, string> = { email: kbEmail, duration: kbDuration === "custom" ? `${Number(kbAmount)}${kbUnit}` : kbDuration };
                  if (kbReason.trim()) params.reason = kbReason.trim();
                  void run("keyblock", "keyblock", params, kbDuration === "permanent" ? `API ${kbEmail} diblokir selamanya.` : `API ${kbEmail} diblokir selama ${kbLabel}.`).then((ok) => {
                    if (ok && alive.current) {
                      setKbWho("");
                      setKbReason("");
                    }
                  });
                }}
              >
                <h2 className="font-mono text-lg font-bold">Blokir API pengguna</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`${ids}-kb-akun`} className="block text-sm font-medium">
                      Email atau username akun
                    </label>
                    <input
                      id={`${ids}-kb-akun`}
                      value={kbWho}
                      onChange={(e) => setKbWho(e.target.value)}
                      list={`${ids}-kb-daftar`}
                      placeholder="nama@email.com"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={254}
                      aria-invalid={!!kbProblem}
                      aria-describedby={`${ids}-kb-help`}
                      className="field mt-1"
                    />
                    <datalist id={`${ids}-kb-daftar`}>
                      {users?.users
                        .filter((u) => !u.is_admin)
                        .map((u) => (
                          <option key={u.email} value={u.email}>
                            {u.username ? `@${u.username}` : ""}
                          </option>
                        ))}
                    </datalist>
                  </div>
                  <div>
                    <label htmlFor={`${ids}-kb-lama`} className="block text-sm font-medium">
                      Lama blokir
                    </label>
                    <select id={`${ids}-kb-lama`} value={kbDuration} onChange={(e) => setKbDuration(e.target.value)} className="field mt-1">
                      {DURATIONS.map((d) => (
                        <option key={d.v} value={d.v}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {kbDuration === "custom" && (
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-sm">
                    <div>
                      <label htmlFor={`${ids}-kb-angka`} className="block text-sm font-medium">
                        Lamanya
                      </label>
                      <input id={`${ids}-kb-angka`} inputMode="numeric" value={kbAmount} onChange={(e) => setKbAmount(e.target.value.replace(/\D/g, "").slice(0, 7))} aria-invalid={!kbCustomOk} aria-describedby={`${ids}-kb-help`} className="field mt-1" />
                    </div>
                    <div>
                      <label htmlFor={`${ids}-kb-satuan`} className="block text-sm font-medium">
                        Satuan
                      </label>
                      <select id={`${ids}-kb-satuan`} value={kbUnit} onChange={(e) => setKbUnit(e.target.value as "m" | "h" | "d")} className="field mt-1">
                        {UNITS.map((x) => (
                          <option key={x.v} value={x.v}>
                            {x.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div>
                    <label htmlFor={`${ids}-kb-alasan`} className="block text-sm font-medium">
                      Alasan (opsional, tampil ke pengguna)
                    </label>
                    <input id={`${ids}-kb-alasan`} value={kbReason} onChange={(e) => setKbReason(e.target.value)} placeholder="mis. Spam permintaan" maxLength={300} autoComplete="off" className="field mt-1" />
                  </div>
                  <button type="submit" disabled={!!busy || !kbReady} className="btn btn-danger">
                    {busy === "keyblock" ? "Memblokir…" : kbDuration === "permanent" ? "Blokir selamanya" : "Blokir sementara"}
                  </button>
                </div>
                <p id={`${ids}-kb-help`} className={`mt-2 text-sm ${kbProblem ? "font-medium text-danger" : "text-muted"}`}>
                  {kbProblem ||
                    "API key akun yang diblokir dijawab 403 beserta alasannya, termasuk key baru bila pengguna menggantinya. Akunnya masih bisa masuk ke situs dan melihat pemberitahuan blokir. Blokir sementara berakhir sendiri; memblokir ulang akun yang sama mengganti lama dan alasannya."}
                </p>
              </form>

              {!keyBlocks && !errors.kunci && <div className="h-32 animate-pulse bg-subtle" aria-hidden />}
              {keyBlocks && keyBlocks.users.length === 0 && <p className="border border-line bg-card p-4 text-muted">Tidak ada akun yang API-nya sedang diblokir.</p>}
              {keyBlocks && keyBlocks.users.length > 0 && (
                <ul className="space-y-3">
                  {keyBlocks.users.map((b) => (
                    <li key={b.email} className="flex flex-col gap-3 border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h2 className="wrap-anywhere font-mono text-base font-bold">{b.username ? `@${b.username}` : b.email}</h2>
                          <Badge tone="danger">{b.api_blocked_until ? "Sementara" : "Selamanya"}</Badge>
                        </div>
                        {b.username && <p className="wrap-anywhere mt-1 text-sm text-muted">{b.email}</p>}
                        <p className="tnum wrap-anywhere mt-1 text-sm">{b.api_blocked_until ? `Sampai ${moment(b.api_blocked_until)}` : "Tanpa batas waktu"}</p>
                        <p className="wrap-anywhere mt-1 text-sm text-muted">
                          {b.api_block_reason || "Tanpa alasan"}
                          {b.api_blocked_at ? `, sejak ${moment(b.api_blocked_at)}` : ""}
                        </p>
                      </div>
                      <button type="button" disabled={!!busy} onClick={() => void run(`kb:${b.email}`, "keyunblock", { email: b.email }, `Blokir API ${b.email} dibuka.`)} className="btn btn-secondary shrink-0">
                        {busy === `kb:${b.email}` ? "Membuka…" : "Buka blokir"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "api" && (
            <section className="space-y-4">
              <form
                className="border border-line bg-card p-4 sm:p-6"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!apiTarget) return;
                  const params: Record<string, string> = { path: apiTarget };
                  if (apiReason.trim()) params.reason = apiReason.trim();
                  void run("apiblock", "apiblock", params, `/api/${apiTarget} dinonaktifkan.`).then((ok) => {
                    if (ok && alive.current) {
                      setApiPick("");
                      setApiReason("");
                      setApiFilter("");
                    }
                  });
                }}
              >
                <h2 className="font-mono text-lg font-bold">Nonaktifkan endpoint</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr]">
                  <div>
                    <label htmlFor={`${ids}-api-saring`} className="block text-sm font-medium">
                      Saring daftar
                    </label>
                    <input id={`${ids}-api-saring`} type="search" value={apiFilter} onChange={(e) => setApiFilter(e.target.value)} placeholder="mis. film, tiktok" autoComplete="off" spellCheck={false} className="field mt-1" />
                  </div>
                  <div>
                    <label htmlFor={`${ids}-api-pilih`} className="block text-sm font-medium">
                      Endpoint atau kategori
                    </label>
                    <select id={`${ids}-api-pilih`} value={apiTarget} onChange={(e) => setApiPick(e.target.value)} aria-describedby={`${ids}-api-help`} className="field mt-1">
                      <option value="">{apiOffered === 0 ? "Tidak ada endpoint yang cocok" : `Pilih dari ${fmt(apiOffered)} endpoint`}</option>
                      {apiGroups.map((g) => (
                        <optgroup key={g.c.id} label={g.c.name}>
                          <option value={`${g.c.id}/*`} disabled={blockedNow.has(`${g.c.id}/*`)}>
                            Semua endpoint {g.c.name} ({fmt(g.count)}){blockedNow.has(`${g.c.id}/*`) ? ", sudah nonaktif" : ""}
                          </option>
                          {g.items.map((e) => (
                            <option key={e.id} value={e.id} disabled={blockedNow.has(e.id)}>
                              {e.title} (/api/{e.id}){blockedNow.has(e.id) ? ", sudah nonaktif" : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div>
                    <label htmlFor={`${ids}-api-alasan`} className="block text-sm font-medium">
                      Alasan (opsional, tampil ke pengguna)
                    </label>
                    <input id={`${ids}-api-alasan`} value={apiReason} onChange={(e) => setApiReason(e.target.value)} placeholder="mis. Sumber data sedang gangguan" maxLength={300} autoComplete="off" className="field mt-1" />
                  </div>
                  <button type="submit" disabled={!!busy || !apiTarget} className="btn btn-danger">
                    {busy === "apiblock" ? "Menonaktifkan…" : "Nonaktifkan"}
                  </button>
                </div>
                <p id={`${ids}-api-help`} className="mt-2 text-sm text-muted">
                  Permintaan ke endpoint yang dinonaktifkan dijawab 503 beserta alasannya dan tidak mengurangi kuota pengguna. Endpoint itu juga ditandai Nonaktif di halaman dokumentasi. Berlaku di semua server dalam 30 detik.
                </p>
              </form>

              {!apiBlocks && !errors.api && <div className="h-32 animate-pulse bg-subtle" aria-hidden />}
              {apiBlocks && apiBlocks.blocks.length === 0 && <p className="border border-line bg-card p-4 text-muted">Tidak ada endpoint yang sedang dinonaktifkan.</p>}
              {apiBlocks && apiBlocks.blocks.length > 0 && (
                <ul className="space-y-3">
                  {apiBlocks.blocks.map((b) => (
                    <li key={b.path} className="flex flex-col gap-3 border border-line bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h2 className="wrap-anywhere font-mono text-base font-bold">/api/{b.path}</h2>
                          {b.scope === "category" && <Badge tone="danger">Satu kategori</Badge>}
                          {b.exists === false && <Badge>Endpoint sudah tidak ada</Badge>}
                        </div>
                        {b.title && <p className="mt-1 text-sm">{b.title}</p>}
                        <p className="wrap-anywhere mt-1 text-sm text-muted">
                          {b.reason || "Tanpa alasan"}
                          {b.created_at ? `, sejak ${moment(b.created_at)}` : ""}
                        </p>
                      </div>
                      <button type="button" disabled={!!busy} onClick={() => void run(`apiunblock:${b.path}`, "apiunblock", { path: b.path }, `/api/${b.path} aktif lagi.`)} className="btn btn-secondary shrink-0">
                        {busy === `apiunblock:${b.path}` ? "Mengaktifkan…" : "Aktifkan lagi"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "pembayaran" && (
            <section>
              {!payment && !errors.pembayaran && <div className="h-40 animate-pulse bg-subtle" aria-hidden />}
              {payment && (
                <div className="border border-line bg-card p-4 sm:p-6">
                  <h2 className="font-mono text-lg font-bold">Payment gateway QRIS</h2>
                  <dl className="mt-3 divide-y divide-line text-sm">
                    {[
                      ["API key gateway", payment.api_key_set ? "Terpasang" : "Belum diisi (WELPER_API_KEY)", payment.api_key_set],
                      ["Secret webhook", payment.webhook_secret_set ? "Terpasang" : "Belum diisi (WELPER_WEBHOOK_SECRET)", payment.webhook_secret_set],
                      ["Koneksi ke gateway", payment.gateway_reachable ? "Bisa dihubungi" : "Tidak bisa dihubungi", payment.gateway_reachable],
                      ["Biaya QRIS", payment.fee_bearer === "customer" ? "Ditanggung pembeli" : "Dipotong dari yang kamu terima", true],
                      ["Harga limit tambahan", payment.limit_step && payment.limit_price ? `${rupiah(payment.limit_price * payment.limit_step)} per ${fmt(payment.limit_step)} limit` : "-", true],
                    ].map(([k, v, good]) => (
                      <div key={String(k)} className="flex flex-col gap-1 py-2 sm:flex-row sm:justify-between sm:gap-6">
                        <dt className="text-muted">{k}</dt>
                        <dd className={`font-medium ${good ? "" : "text-danger"}`}>{v}</dd>
                      </div>
                    ))}
                    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:justify-between sm:gap-6">
                      <dt className="text-muted">URL webhook</dt>
                      <dd className="wrap-anywhere font-mono">{payment.webhook_url}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-sm text-muted">Nama, harga, dan kuota paket diatur di kode (src/lib/plans.ts), bukan dari panel ini.</p>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </Frame>
  );
}
