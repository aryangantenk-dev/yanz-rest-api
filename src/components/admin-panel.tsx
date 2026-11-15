"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "./auth-client";
import { ArrowIcon, RefreshIcon } from "./icons";

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
};
type Users = { total: number; users: UserRow[] };
type OrderRow = { id: string; email: string; username: string; plan: string; months: number; amount: number; total: number | null; status: string; gateway_ref: string; created_at: string; paid_at: string | null };
type Orders = { paid: number; paid_amount: number; orders: OrderRow[] };
type Ban = { ip: string; reason: string; created_at: string | null };
type Bans = { total: number; bans: Ban[] };
type Payment = { plan_days: number; api_key_set: boolean; webhook_secret_set: boolean; fee_bearer: string; gateway_reachable: boolean; webhook_url: string };
type Notice = { tone: "ok" | "danger"; text: string };
type Tab = "akun" | "pesanan" | "blokir" | "pembayaran";

const OFFLINE = "Tidak dapat terhubung ke server. Periksa koneksimu, lalu coba lagi.";
const STATUS_LABEL: Record<string, string> = { pending: "Menunggu pembayaran", paid: "Lunas", expired: "Kedaluwarsa", canceled: "Dibatalkan", failed: "Gagal dibuat" };
const TABS: { id: Tab; label: string }[] = [
  { id: "akun", label: "Akun" },
  { id: "pesanan", label: "Pesanan" },
  { id: "blokir", label: "Blokir IP" },
  { id: "pembayaran", label: "Pembayaran" },
];

const nf = new Intl.NumberFormat("id-ID");
const fmt = (n: number | undefined | null) => nf.format(Number(n) || 0);
const rupiah = (n: number | undefined | null) => `Rp${fmt(n)}`;
const moment = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-");
const dateLong = (iso: string) => new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });

type Answer<T> = { ok: boolean; status: number; result: T | null; error: string };

/** Panggil /api/admin/<aksi> dengan sesi login. Header penanda wajib ada; lihat catatan di rute itu. */
async function call<T>(action: string, params: Record<string, string> = {}): Promise<Answer<T>> {
  try {
    const qs = new URLSearchParams(params).toString();
    const r = await fetch(`/api/admin/${action}${qs ? `?${qs}` : ""}`, { cache: "no-store", credentials: "same-origin", headers: { "x-requested-with": "yanz-admin" } });
    const body = (await r.json().catch(() => ({}))) as { result?: T; error?: string };
    return { ok: r.ok, status: r.status, result: r.ok ? (body.result ?? null) : null, error: body.error || (r.ok ? "" : `Server menjawab ${r.status}.`) };
  } catch {
    return { ok: false, status: 0, result: null, error: OFFLINE };
  }
}

function Badge({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "ok" | "danger" }) {
  const cls = tone === "ok" ? "border-[var(--accent-edge)] text-fg" : tone === "danger" ? "border-danger text-danger" : "border-control text-muted";
  return <span className={`inline-flex items-center border px-1.5 py-0.5 font-mono text-xs font-semibold ${cls}`}>{children}</span>;
}

/** Tombol untuk aksi yang berdampak besar: klik pertama meminta kepastian, klik kedua menjalankan. */
function ConfirmButton({ label, confirmLabel, onConfirm, disabled, className = "btn btn-danger" }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; className?: string }) {
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

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header className="mb-8">
        <h1 className="font-mono text-[2rem] font-bold leading-tight tracking-tight sm:text-[2.5rem]">Admin</h1>
        <p className="mt-3 max-w-[60ch] text-lg text-muted">Akun pengguna, pesanan paket, blokir IP, dan status pembayaran.</p>
      </header>
      {children}
    </div>
  );
}

export function AdminPanel({ authEnabled, plans, planDays }: { authEnabled: boolean; plans: PlanOption[]; planDays: number }) {
  const auth = useAuth(authEnabled);
  const isAdmin = auth.user?.admin === true;
  const [tab, setTab] = useState<Tab>("akun");
  const [users, setUsers] = useState<Users | null>(null);
  const [orders, setOrders] = useState<Orders | null>(null);
  const [bans, setBans] = useState<Bans | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Tab, string>>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [planPick, setPlanPick] = useState(plans.find((p) => p.paid)?.id ?? plans[0]?.id ?? "free");
  const [daysPick, setDaysPick] = useState(String(planDays));
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
    const [u, o, b, p] = await Promise.all([call<Users>("users"), call<Orders>("orders"), call<Bans>("bans"), call<Payment>("paket")]);
    if (!alive.current) return;
    if (u.result) setUsers(u.result);
    if (o.result) setOrders(o.result);
    if (b.result) setBans(b.result);
    if (p.result) setPayment(p.result);
    setErrors({ akun: u.ok ? undefined : u.error, pesanan: o.ok ? undefined : o.error, blokir: b.ok ? undefined : b.error, pembayaran: p.ok ? undefined : p.error });
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
  async function run(id: string, action: string, params: Record<string, string>, done: string) {
    setBusy(id);
    setNotice(null);
    const r = await call<{ message?: string }>(action, params);
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok) {
      setNotice({ tone: "danger", text: r.error });
      return;
    }
    setNotice({ tone: "ok", text: done });
    setEditing(null);
    await load();
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
  const first = users === null && orders === null && bans === null && payment === null && Object.keys(errors).length === 0;

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

                      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                        <button type="button" onClick={() => setEditing(open ? null : u.email)} aria-expanded={open} className="btn btn-secondary">
                          {open ? "Batal" : "Atur paket"}
                        </button>
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
                              {planName(o.plan)}, {o.months} bulan
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
                  void run("ipban", "ban", params, `IP ${ip} diblokir.`).then(() => {
                    if (alive.current) {
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
                      ["Satu masa aktif", `${fmt(payment.plan_days)} hari`, true],
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
