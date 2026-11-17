"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FEATURED_BADGE, FEATURED_PLAN, LIMIT_PLAN, PLAN_PITCH, formatNumber, rupiah, type Plan } from "@/lib/plans";
import { refreshAuth, useAuth } from "./auth-client";
import { ArrowIcon, CheckIcon, RefreshIcon } from "./icons";
import { RedeemForm } from "./rewards";

type PlanInfo = { id: string; name: string; daily: number; perMinute: number; paid: boolean; expires_at: string | null; /** Tanpa kuota harian: akun admin (id "admin") atau paket tanpa batas. */ unlimited?: boolean; /** Saldo limit tambahan. */ extra?: number };
type Order = { id: string; plan: string; days: number; qty: number; amount: number; total: number | null; status: string; payment_url: string; expires_at: string | null; created_at: string; paid_at: string | null };
type Me = { plan: PlanInfo; today: number; orders: Order[]; payment: boolean; needsUsername: boolean };
type Notice = { tone: "ok" | "info" | "danger"; text: string };
/** Aturan pembelian limit tambahan (dari src/lib/plans.ts). */
export type LimitRules = { price: number; step: number; min: number; max: number; choices: readonly number[] };

const OFFLINE = "Tidak dapat terhubung ke server. Periksa koneksimu, lalu coba lagi.";
const ORDER_ID_RE = /^YZ-[0-9A-Z]{6,12}-[0-9A-F]{10}$/;
/** Jeda dan batas lama menunggu konfirmasi pembayaran setelah kembali dari halaman bayar. */
const WATCH_MS = 3_000;
const WATCH_TRIES = 40;

const dateLong = (iso: string) => new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
const dateTime = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

const STATUS_LABEL: Record<string, string> = { pending: "Menunggu pembayaran", paid: "Lunas", expired: "Kedaluwarsa", canceled: "Dibatalkan", failed: "Gagal dibuat" };

async function getJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  try {
    const r = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: OFFLINE } as T & { error?: string } };
  }
}

/** Tagihan yang masih bisa dibayar: menunggu, punya tautan bayar, dan belum lewat batas waktunya. */
const payable = (o: Order) => o.status === "pending" && !!o.payment_url && (!o.expires_at || Date.parse(o.expires_at) > Date.now());

type BuyState = { authEnabled: boolean; signedIn: boolean; needsUsername: boolean; canPay: boolean; busy: string | null; ownerUrl: string };

/** Tombol beli beserta keadaan lain yang menggantikannya (belum masuk, belum punya username, pembayaran belum aktif). */
function BuyArea({ state, id, label, disabled, what, onBuy }: { state: BuyState; /** Penanda tombol ini di `state.busy`. */ id: string; label: string; disabled: boolean; /** Nama barangnya di dalam kalimat, misalnya "paket ini". */ what: string; onBuy: () => void }) {
  if (!state.authEnabled) return <p className="text-sm text-muted">Login belum diaktifkan di server ini, jadi {what} belum bisa dibeli.</p>;
  if (!state.signedIn) {
    // Label penawaran tetap tampil supaya pengunjung melihat tawaran paketnya, bukan hanya ajakan masuk.
    return (
      <>
        <Link href="/login?next=/paket" className="btn btn-primary w-full">
          {label}
          <ArrowIcon />
        </Link>
        <p className="mt-2 text-sm text-muted">Perlu masuk dulu; akun dan API key gratis.</p>
      </>
    );
  }
  if (state.needsUsername) {
    return (
      <Link href="/akun?next=/paket" className="btn btn-primary w-full">
        Pilih username dulu
        <ArrowIcon />
      </Link>
    );
  }
  if (!state.canPay) {
    return (
      <>
        <p className="text-sm text-muted">Pembayaran otomatis belum aktif. Untuk membeli {what}, hubungi owner.</p>
        <a href={state.ownerUrl} target="_blank" rel="noreferrer" className="btn btn-secondary mt-3 w-full">
          Hubungi owner lewat WhatsApp
        </a>
      </>
    );
  }
  return (
    <button type="button" onClick={onBuy} disabled={!!state.busy || disabled} className="btn btn-primary w-full">
      {state.busy === id ? "Membuat tagihan…" : label}
      {state.busy !== id && <ArrowIcon />}
    </button>
  );
}

export function PlanPanel({
  plans,
  dayChoices,
  maxDays,
  limit,
  total,
  enabled,
  authEnabled,
  paymentReady,
  feeOnCustomer,
  ownerUrl,
}: {
  plans: readonly Plan[];
  /** Pilihan cepat jumlah hari; pembeli juga bisa mengisi sendiri sampai `maxDays`. */
  dayChoices: readonly number[];
  maxDays: number;
  limit: LimitRules;
  /** Jumlah endpoint, untuk daftar isi paket. */
  total: number;
  /** API key diwajibkan di server ini; tanpa itu kuota paket tidak berlaku. */
  enabled: boolean;
  authEnabled: boolean;
  paymentReady: boolean;
  feeOnCustomer: boolean;
  ownerUrl: string;
}) {
  const auth = useAuth(authEnabled);
  const signedIn = !!auth.user;
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dayText, setDayText] = useState(String(dayChoices.includes(7) ? 7 : (dayChoices[0] ?? 1)));
  const [qtyText, setQtyText] = useState(String(limit.choices[0] ?? limit.min));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const alive = useRef(true);
  const watching = useRef<string | null>(null);

  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? id;
  /** Isi sebuah pesanan dalam kata-kata: paket dan jumlah harinya, atau jumlah limit tambahan. */
  const orderLabel = (o: Order) => (o.plan === LIMIT_PLAN ? `Limit tambahan ${formatNumber(o.qty)} permintaan` : `Paket ${planName(o.plan)}${o.days > 0 ? ` ${formatNumber(o.days)} hari` : ""}`);

  const load = useCallback(async () => {
    const r = await getJson<Me>("/api/paket/me");
    if (!alive.current) return null;
    if (r.status === 401) {
      void refreshAuth();
      return null;
    }
    if (!r.ok || !r.body.plan) {
      setLoadError(r.body.error ?? "Data paket belum bisa dimuat. Coba lagi.");
      return null;
    }
    setLoadError(null);
    setMe(r.body);
    return r.body;
  }, []);

  /** Pantau satu pesanan sampai lunas, kedaluwarsa, atau batas waktu menunggu habis. */
  const watch = useCallback(
    async (id: string) => {
      if (watching.current === id) return;
      watching.current = id;
      setNotice({ tone: "info", text: "Memeriksa pembayaran…" });
      for (let i = 0; i < WATCH_TRIES && alive.current && watching.current === id; i++) {
        const r = await getJson<{ order?: Order; plan?: PlanInfo }>(`/api/paket/status?order=${encodeURIComponent(id)}`);
        if (!alive.current || watching.current !== id) return;
        const order = r.body.order;
        if (r.status === 401 || r.status === 404) break;
        if (order?.status === "paid") {
          watching.current = null;
          const fresh = await load();
          const now = fresh?.plan ?? r.body.plan;
          if (order.plan === LIMIT_PLAN) {
            setNotice({ tone: "ok", text: `Pembayaran diterima. ${formatNumber(order.qty)} limit tambahan sudah masuk${now ? `; saldo limit tambahanmu sekarang ${formatNumber(now.extra ?? 0)}` : ""}. API key kamu bisa memakainya paling lama satu menit lagi.` });
          } else {
            setNotice({ tone: "ok", text: `Pembayaran diterima. Paket ${now?.name ?? ""} aktif${now?.expires_at ? ` sampai ${dateLong(now.expires_at)}` : ""}. API key kamu memakai kuota baru paling lama satu menit lagi.` });
          }
          return;
        }
        if (order && order.status !== "pending") {
          watching.current = null;
          void load();
          setNotice({ tone: "danger", text: `Tagihan ${order.id} ${order.status === "expired" ? "sudah kedaluwarsa" : "tidak berlaku lagi"}. Buat tagihan baru bila masih ingin membeli.` });
          return;
        }
        await new Promise((res) => window.setTimeout(res, WATCH_MS));
      }
      if (!alive.current || watching.current !== id) return;
      watching.current = null;
      setNotice({ tone: "info", text: "Pembayaran belum terkonfirmasi. Kalau kamu sudah membayar, tunggu sebentar lalu tekan Cek status; pembelianmu aktif otomatis begitu pembayaran masuk." });
    },
    [load],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    // Kembali dari halaman bayar: gateway menambahkan merchant_ref ke alamat halaman ini.
    const sp = new URLSearchParams(window.location.search);
    const back = (sp.get("merchant_ref") || sp.get("order") || "").toUpperCase();
    if (ORDER_ID_RE.test(back)) {
      window.history.replaceState(null, "", window.location.pathname);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mulai memantau pesanan yang baru dibayar
      void watch(back);
    }
    void load();
  }, [signedIn, load, watch]);

  /** Buat tagihan lalu pindah ke halaman bayar. `id` menandai tombol mana yang sedang sibuk. */
  async function buy(id: string, payload: { plan: string; days?: number; qty?: number }) {
    if (busy) return;
    setBusy(id);
    setNotice(null);
    const r = await getJson<{ payment_url?: string; order?: Order }>("/api/paket/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!alive.current) return;
    if (r.status === 401) void refreshAuth();
    if (r.ok && r.body.payment_url) {
      // Tetap "sibuk" sampai halaman berpindah supaya tombol tidak bisa ditekan dua kali.
      window.location.assign(r.body.payment_url);
      return;
    }
    setBusy(null);
    if (r.ok && r.body.order?.status === "paid") {
      void load();
      setNotice({ tone: "ok", text: "Pesanan ini sudah lunas dan sudah aktif di akunmu." });
      return;
    }
    setNotice({ tone: "danger", text: r.body.error ?? "Tagihan gagal dibuat. Coba lagi." });
  }

  const current = signedIn ? me?.plan : undefined;
  const isAdmin = current?.id === "admin";
  const extra = current?.extra ?? 0;
  const open = me?.orders.find(payable);
  const usedPct = current ? Math.min(100, (me!.today / Math.max(1, current.daily)) * 100) : 0;

  const days = /^\d{1,3}$/.test(dayText) ? Number(dayText) : NaN;
  const daysOk = Number.isInteger(days) && days >= 1 && days <= maxDays;
  const qty = /^\d{1,9}$/.test(qtyText) ? Number(qtyText) : NaN;
  const qtyOk = Number.isInteger(qty) && qty >= limit.min && qty <= limit.max && qty % limit.step === 0;
  const feeNote = feeOnCustomer ? "Belum termasuk biaya QRIS dan kode unik beberapa ratus rupiah; nominal persisnya tampil di halaman bayar." : "Ditambah kode unik beberapa ratus rupiah; nominal persisnya tampil di halaman bayar.";

  const buyState = { authEnabled, signedIn, needsUsername: !!(auth.needsUsername || me?.needsUsername), canPay: me ? me.payment : paymentReady, busy, ownerUrl };

  return (
    <div className="space-y-6">
      {!enabled && (
        <p className="border border-control bg-card p-4 text-muted">API key belum diwajibkan di server ini, jadi semua permintaan belum dihitung ke kuota paket mana pun.</p>
      )}

      <p role="status" aria-live="polite" className={notice ? `border p-3 font-medium ${notice.tone === "danger" ? "border-danger text-danger" : notice.tone === "ok" ? "border-[var(--accent-edge)] bg-card text-fg" : "border-control bg-card text-fg"}` : "sr-only"}>
        {notice?.text}
      </p>

      {signedIn && loadError && !me && (
        <div className="border border-danger p-4">
          <p className="font-medium text-danger">{loadError}</p>
          <button type="button" onClick={() => void load()} className="btn btn-secondary mt-3">
            Coba lagi
          </button>
        </div>
      )}

      {current && isAdmin && me && (
        <section aria-labelledby="paket-kamu" className="border border-line bg-card p-4 sm:p-6">
          <h2 id="paket-kamu" className="font-mono text-lg font-bold">
            Akun admin
          </h2>
          <p className="tnum mt-2 text-sm text-muted">
            Akun ini tidak terkena kuota harian. <strong className="font-mono font-semibold text-fg">{formatNumber(me.today)}</strong> permintaan hari ini.
          </p>
        </section>
      )}

      {current && !isAdmin && me && (
        <section aria-labelledby="paket-kamu" className="border border-line bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="paket-kamu" className="font-mono text-lg font-bold">
              Paket kamu: {current.name}
            </h2>
            <p className="text-sm text-muted">{current.paid && current.expires_at ? `Aktif sampai ${dateLong(current.expires_at)}` : "Tanpa batas waktu"}</p>
          </div>
          {current.unlimited ? (
            <p className="tnum mt-3 text-sm">
              Tanpa kuota harian. <strong className="font-mono text-base font-semibold">{formatNumber(me.today)}</strong> permintaan hari ini.
            </p>
          ) : (
            <>
              <p className="tnum mt-3 text-sm">
                <strong className="font-mono text-base font-semibold">{formatNumber(me.today)}</strong> dari {formatNumber(current.daily)} permintaan terpakai hari ini
              </p>
              <div className="mt-2 h-2 bg-subtle" role="progressbar" aria-label="Kuota harian terpakai" aria-valuemin={0} aria-valuemax={current.daily} aria-valuenow={Math.min(me.today, current.daily)}>
                <span className={`block h-full ${usedPct >= 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${usedPct}%` }} />
              </div>
              <p className="mt-2 text-sm text-muted">Kuota terisi lagi setiap pukul 00.00 WIB.</p>
            </>
          )}
          <p className="tnum mt-3 border-t border-line pt-3 text-sm">
            Limit tambahan: <strong className="font-mono text-base font-semibold">{formatNumber(extra)}</strong> permintaan
            <span className="text-muted">{current.unlimited ? ". Tidak terpakai selama paket ini aktif." : extra > 0 ? ". Dipakai setelah kuota harian habis." : "."}</span>
          </p>
        </section>
      )}

      {open && (
        <section aria-labelledby="paket-tagihan" className="border border-control bg-card p-4 sm:p-6">
          <h2 id="paket-tagihan" className="font-mono text-lg font-bold">
            Ada tagihan yang menunggu pembayaran
          </h2>
          <p className="tnum mt-2 text-muted">
            {orderLabel(open)}, {rupiah(open.total ?? open.amount)}
            {open.expires_at ? `, berlaku sampai pukul ${clock(open.expires_at)}` : ""}. Nomor pesanan <span className="wrap-anywhere font-mono text-fg">{open.id}</span>.
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <a href={open.payment_url} className="btn btn-primary">
              Lanjutkan pembayaran
              <ArrowIcon />
            </a>
            <button type="button" onClick={() => void watch(open.id)} className="btn btn-secondary">
              <RefreshIcon />
              Cek status
            </button>
          </div>
        </section>
      )}

      <section aria-labelledby="paket-harian">
        <h2 id="paket-harian" className="font-mono text-xl font-bold">
          Pilihan 1: paket harian
        </h2>
        <p className="mt-1 max-w-[70ch] text-muted">Kuota per hari yang lebih besar selama paketnya aktif. Harganya per hari, dan kamu sendiri yang menentukan berapa hari.</p>
        <ul className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {plans.map((plan) => {
            const paid = plan.price > 0;
            const mine = current?.id === plan.id;
            // Paket berbayar lain yang masih aktif akan diganti oleh pembelian ini.
            const replaces = paid && !!current && current.paid && !mine;
            return (
              <li
                key={plan.id}
                id={`paket-${plan.id}`}
                className={`scroll-mt-24 flex flex-col border bg-card p-5 sm:p-6 ${
                  plan.id === FEATURED_PLAN
                    ? "border-[var(--accent-edge)] plan-lift"
                    : mine
                      ? "border-[var(--accent-edge)]"
                      : "border-line"
                }`}
              >
                {plan.id === FEATURED_PLAN && (
                  <p className="mb-3 inline-flex self-start plan-badge px-2 py-1 font-mono text-[0.6875rem] font-bold uppercase tracking-wide">
                    {FEATURED_BADGE}
                  </p>
                )}
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-mono text-2xl font-bold tracking-tight">{plan.name}</h3>
                  {mine && <span className="shrink-0 border border-[var(--accent-edge)] px-2 py-0.5 text-sm font-semibold">Paket kamu</span>}
                </div>
                <p className="tnum mt-2">
                  <span className="font-mono text-[2rem] font-bold leading-tight">{paid ? rupiah(plan.price) : "Rp0"}</span>
                  {paid && <span className="text-muted"> / hari</span>}
                </p>
                <p className="mt-2 text-muted">{PLAN_PITCH[plan.id].tagline}</p>
                {PLAN_PITCH[plan.id].note && (
                  <p className="mt-2 inline-flex self-start border border-[var(--accent-edge)] px-2 py-0.5 font-mono text-xs font-semibold text-ok">
                    {PLAN_PITCH[plan.id].note}
                  </p>
                )}
                <ul className="tnum mt-4 space-y-2">
                  {[
                    plan.unlimited ? "Permintaan per hari tanpa batas" : `${formatNumber(plan.daily)} permintaan per hari`,
                    `${formatNumber(plan.perMinute)} permintaan per menit${paid ? " per akun" : " per IP"}`,
                    `Semua ${formatNumber(total)} endpoint`,
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-2">
                      <CheckIcon className="mt-1 shrink-0 text-ok" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-auto pt-6">
                  {!paid ? (
                    signedIn ? (
                      <p className="text-sm text-muted">Paket dasar untuk semua akun. Tidak perlu membayar apa pun.</p>
                    ) : authEnabled ? (
                      <Link href="/daftar?next=/paket" className="btn btn-secondary w-full">
                        Mulai Gratis
                        <ArrowIcon />
                      </Link>
                    ) : null
                  ) : (
                    <>
                      <fieldset>
                        <legend className="text-sm font-semibold">Lama paket</legend>
                        <div className="mt-2 grid grid-cols-4 border border-control">
                          {dayChoices.map((d, i) => (
                            <label key={d} className={`flex min-h-11 cursor-pointer items-center justify-center px-1 text-center text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${i > 0 ? "border-l border-control" : ""} ${days === d ? "bg-fg text-bg" : "hover:bg-subtle"}`}>
                              <input type="radio" name={`lama-${plan.id}`} value={d} checked={days === d} onChange={() => setDayText(String(d))} className="sr-only" />
                              {d} hari
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <label htmlFor={`hari-${plan.id}`} className="mt-3 block text-sm font-medium">
                        Atau isi jumlah hari sendiri
                      </label>
                      <input
                        id={`hari-${plan.id}`}
                        inputMode="numeric"
                        autoComplete="off"
                        value={dayText}
                        onChange={(e) => setDayText(e.target.value.replace(/\D/g, "").slice(0, 3))}
                        aria-invalid={!daysOk}
                        aria-describedby={`hari-${plan.id}-info`}
                        className="field tnum mt-1"
                      />
                      <p id={`hari-${plan.id}-info`} className={`tnum mt-3 ${daysOk ? "" : "font-medium text-danger"}`}>
                        {daysOk ? (
                          <>
                            Total <strong className="font-mono font-semibold">{rupiah(plan.price * days)}</strong> untuk {formatNumber(days)} hari
                          </>
                        ) : (
                          `Isi jumlah hari dari 1 sampai ${maxDays}.`
                        )}
                      </p>
                      <p className="mt-1 text-sm text-muted">{feeNote}</p>
                      {replaces && current?.expires_at && (
                        <p className="mt-2 text-sm font-medium text-danger">
                          Paket {current.name} kamu masih aktif sampai {dateLong(current.expires_at)}. Membeli paket ini menggantinya, dan sisa harinya hangus.
                        </p>
                      )}
                      {mine && current?.expires_at && daysOk && <p className="mt-2 text-sm text-muted">Hari yang dibeli ditambahkan ke masa aktif yang sekarang.</p>}
                      <div className="mt-4">
                        <BuyArea
                          state={buyState}
                          id={plan.id}
                          label={mine ? "Perpanjang dengan QRIS" : PLAN_PITCH[plan.id].cta}
                          disabled={!daysOk}
                          what="paket ini"
                          onBuy={() => void buy(plan.id, { plan: plan.id, days })}
                        />
                      </div>
                      <p className="mt-2 text-sm text-muted">
                        ⚡ Aktivasi otomatis 1 detik setelah pembayaran QRIS (GoPay, DANA, OVO, ShopeePay, M-Banking).
                      </p>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="paket-limit" className="border border-line bg-card p-5 sm:p-6">
        <h2 id="paket-limit" className="font-mono text-xl font-bold">
          Pilihan 2: limit tambahan
        </h2>
        <p className="tnum mt-1 max-w-[70ch] text-muted">
          Beli limit sebanyak yang kamu butuhkan: {rupiah(limit.price * limit.step)} untuk {formatNumber(limit.step)} limit, dan satu limit berarti satu permintaan. Limit dipakai otomatis setelah kuota harian paketmu habis, tidak hangus, dan bisa dipakai bersama paket apa pun.
        </p>
        {current && !isAdmin && (
          <p className="tnum mt-3">
            Saldo kamu sekarang: <strong className="font-mono font-semibold">{formatNumber(extra)}</strong> limit
          </p>
        )}
        <div className="mt-4 max-w-md">
          <fieldset>
            <legend className="text-sm font-semibold">Jumlah limit</legend>
            <div className="mt-2 grid grid-cols-4 border border-control">
              {limit.choices.map((n, i) => (
                <label key={n} className={`tnum flex min-h-11 cursor-pointer items-center justify-center px-1 text-center text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${i > 0 ? "border-l border-control" : ""} ${qty === n ? "bg-fg text-bg" : "hover:bg-subtle"}`}>
                  <input type="radio" name="jumlah-limit" value={n} checked={qty === n} onChange={() => setQtyText(String(n))} className="sr-only" />
                  {formatNumber(n)}
                </label>
              ))}
            </div>
          </fieldset>
          <label htmlFor="limit-sendiri" className="mt-3 block text-sm font-medium">
            Atau isi jumlah limit sendiri
          </label>
          <input
            id="limit-sendiri"
            inputMode="numeric"
            autoComplete="off"
            value={qtyText}
            onChange={(e) => setQtyText(e.target.value.replace(/\D/g, "").slice(0, 9))}
            aria-invalid={!qtyOk}
            aria-describedby="limit-info"
            className="field tnum mt-1"
          />
          <p id="limit-info" className={`tnum mt-3 ${qtyOk ? "" : "font-medium text-danger"}`}>
            {qtyOk ? (
              <>
                Total <strong className="font-mono font-semibold">{rupiah(qty * limit.price)}</strong> untuk {formatNumber(qty)} limit
              </>
            ) : (
              `Isi kelipatan ${formatNumber(limit.step)}, dari ${formatNumber(limit.min)} sampai ${formatNumber(limit.max)}.`
            )}
          </p>
          <p className="tnum mt-1 text-sm text-muted">
            Pembelian terkecil {formatNumber(limit.min)} limit, karena QRIS tidak menerima pembayaran di bawah {rupiah(limit.min * limit.price)}. {feeNote}
          </p>
          {current?.unlimited && !isAdmin && <p className="mt-2 text-sm text-muted">Paket {current.name} kamu sudah tanpa kuota harian, jadi limit ini baru terpakai setelah paketnya berakhir.</p>}
          <div className="mt-4">
            {isAdmin && <p className="mb-3 text-sm text-muted">Akun admin tidak terkena kuota harian, jadi limit yang dibeli tersimpan tetapi tidak terpakai.</p>}
            <BuyArea state={buyState} id={LIMIT_PLAN} label="Beli Kuota Abadi" disabled={!qtyOk} what="limit tambahan" onBuy={() => void buy(LIMIT_PLAN, { plan: LIMIT_PLAN, qty })} />
          </div>
        </div>
      </section>

      {authEnabled && <RedeemForm signedIn={signedIn} needsUsername={!!me?.needsUsername} loginHref="/login?next=/paket" onDone={() => void load()} />}

      {me && me.orders.length > 0 && (
        <section aria-labelledby="paket-riwayat" className="border border-line bg-card p-4 sm:p-6">
          <h2 id="paket-riwayat" className="font-mono text-lg font-bold">
            Riwayat pesanan
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="tnum w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">Tanggal</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Pesanan</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Isi</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Nominal</th>
                  <th scope="col" className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {me.orders.map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-b-0">
                    <td className="py-2 pr-3">{dateTime(o.created_at)}</td>
                    <td className="py-2 pr-3 font-mono">{o.id}</td>
                    <td className="py-2 pr-3">{orderLabel(o)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{rupiah(o.total ?? o.amount)}</td>
                    <td className="py-2">{o.status === "pending" && !payable(o) ? STATUS_LABEL.expired : (STATUS_LABEL[o.status] ?? o.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
