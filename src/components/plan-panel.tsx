"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatNumber, rupiah, type Plan } from "@/lib/plans";
import { refreshAuth, useAuth } from "./auth-client";
import { ArrowIcon, CheckIcon, RefreshIcon } from "./icons";

type PlanInfo = { id: string; name: string; daily: number; perMinute: number; paid: boolean; expires_at: string | null };
type Order = { id: string; plan: string; months: number; amount: number; total: number | null; status: string; payment_url: string; expires_at: string | null; created_at: string; paid_at: string | null };
type Me = { plan: PlanInfo; today: number; orders: Order[]; payment: boolean; needsUsername: boolean };
type Notice = { tone: "ok" | "info" | "danger"; text: string };

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

export function PlanPanel({
  plans,
  months,
  planDays,
  total,
  enabled,
  authEnabled,
  paymentReady,
  feeOnCustomer,
  ownerUrl,
}: {
  plans: readonly Plan[];
  months: readonly number[];
  planDays: number;
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
  const [pick, setPick] = useState(months[0] ?? 1);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const alive = useRef(true);
  const watching = useRef<string | null>(null);

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
          const until = (fresh?.plan ?? r.body.plan)?.expires_at;
          setNotice({ tone: "ok", text: `Pembayaran diterima. Paket ${(fresh?.plan ?? r.body.plan)?.name ?? ""} aktif${until ? ` sampai ${dateLong(until)}` : ""}. API key kamu memakai kuota baru paling lama satu menit lagi.` });
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
      setNotice({ tone: "info", text: "Pembayaran belum terkonfirmasi. Kalau kamu sudah membayar, tunggu sebentar lalu tekan Cek status; paket aktif otomatis begitu pembayaran masuk." });
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

  async function buy(plan: Plan) {
    if (busy) return;
    setBusy(plan.id);
    setNotice(null);
    const r = await getJson<{ payment_url?: string; order?: Order }>("/api/paket/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: plan.id, months: pick }),
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
      setNotice({ tone: "ok", text: "Pesanan ini sudah lunas. Paketmu sudah aktif." });
      return;
    }
    setNotice({ tone: "danger", text: r.body.error ?? "Tagihan gagal dibuat. Coba lagi." });
  }

  const current = signedIn ? me?.plan : undefined;
  const open = me?.orders.find(payable);
  const usedPct = current ? Math.min(100, (me!.today / Math.max(1, current.daily)) * 100) : 0;
  const days = pick * planDays;

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

      {current && me && (
        <section aria-labelledby="paket-kamu" className="border border-line bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="paket-kamu" className="font-mono text-lg font-bold">
              Paket kamu: {current.name}
            </h2>
            <p className="text-sm text-muted">{current.paid && current.expires_at ? `Aktif sampai ${dateLong(current.expires_at)}` : "Tanpa batas waktu"}</p>
          </div>
          <p className="tnum mt-3 text-sm">
            <strong className="font-mono text-base font-semibold">{formatNumber(me.today)}</strong> dari {formatNumber(current.daily)} permintaan terpakai hari ini
          </p>
          <div className="mt-2 h-2 bg-subtle" role="progressbar" aria-label="Kuota harian terpakai" aria-valuemin={0} aria-valuemax={current.daily} aria-valuenow={Math.min(me.today, current.daily)}>
            <span className={`block h-full ${usedPct >= 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${usedPct}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted">Kuota terisi lagi setiap pukul 00.00 WIB.</p>
        </section>
      )}

      {open && (
        <section aria-labelledby="paket-tagihan" className="border border-control bg-card p-4 sm:p-6">
          <h2 id="paket-tagihan" className="font-mono text-lg font-bold">
            Ada tagihan yang menunggu pembayaran
          </h2>
          <p className="tnum mt-2 text-muted">
            Paket {plans.find((p) => p.id === open.plan)?.name ?? open.plan} {open.months} bulan, {rupiah(open.total ?? open.amount)}
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

      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {plans.map((plan) => {
          const paid = plan.price > 0;
          const mine = current?.id === plan.id;
          return (
            <li key={plan.id} className={`flex flex-col border bg-card p-5 sm:p-6 ${mine ? "border-[var(--accent-edge)]" : "border-line"}`}>
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-mono text-2xl font-bold tracking-tight">{plan.name}</h2>
                {mine && <span className="shrink-0 border border-[var(--accent-edge)] px-2 py-0.5 text-sm font-semibold">Paket kamu</span>}
              </div>
              <p className="tnum mt-2">
                <span className="font-mono text-[2rem] font-bold leading-tight">{rupiah(plan.price)}</span>
                {paid && <span className="text-muted"> / {planDays} hari</span>}
              </p>
              <p className="mt-2 text-muted">{plan.blurb}</p>
              <ul className="tnum mt-4 space-y-2">
                {[
                  `${formatNumber(plan.daily)} permintaan per hari`,
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
                      Daftar gratis
                      <ArrowIcon />
                    </Link>
                  ) : null
                ) : (
                  <>
                    <fieldset>
                      <legend className="text-sm font-semibold">Lama berlangganan</legend>
                      <div className="mt-2 grid grid-cols-4 border border-control">
                        {months.map((m, i) => (
                          <label key={m} className={`flex min-h-11 cursor-pointer items-center justify-center px-1 text-center text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${i > 0 ? "border-l border-control" : ""} ${pick === m ? "bg-fg text-bg" : "hover:bg-subtle"}`}>
                            <input type="radio" name={`lama-${plan.id}`} value={m} checked={pick === m} onChange={() => setPick(m)} className="sr-only" />
                            {m} bulan
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <p className="tnum mt-3">
                      Total <strong className="font-mono font-semibold">{rupiah(plan.price * pick)}</strong> untuk {formatNumber(days)} hari
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {feeOnCustomer ? "Belum termasuk biaya QRIS dan kode unik beberapa ratus rupiah; nominal persisnya tampil di halaman bayar." : "Ditambah kode unik beberapa ratus rupiah; nominal persisnya tampil di halaman bayar."}
                    </p>
                    <div className="mt-4">
                      {!authEnabled ? (
                        <p className="text-sm text-muted">Login belum diaktifkan di server ini, jadi paket belum bisa dibeli.</p>
                      ) : !signedIn ? (
                        <Link href="/login?next=/paket" className="btn btn-primary w-full">
                          Masuk untuk membeli
                          <ArrowIcon />
                        </Link>
                      ) : auth.needsUsername || me?.needsUsername ? (
                        <Link href="/akun?next=/paket" className="btn btn-primary w-full">
                          Pilih username dulu
                          <ArrowIcon />
                        </Link>
                      ) : (me ? me.payment : paymentReady) ? (
                        <button type="button" onClick={() => void buy(plan)} disabled={!!busy} className="btn btn-primary w-full">
                          {busy === plan.id ? "Membuat tagihan…" : mine ? "Perpanjang dengan QRIS" : "Bayar dengan QRIS"}
                          {busy !== plan.id && <ArrowIcon />}
                        </button>
                      ) : (
                        <>
                          <p className="text-sm text-muted">Pembayaran otomatis belum aktif. Untuk membeli paket ini, hubungi owner.</p>
                          <a href={ownerUrl} target="_blank" rel="noreferrer" className="btn btn-secondary mt-3 w-full">
                            Hubungi owner lewat WhatsApp
                          </a>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

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
                  <th scope="col" className="py-2 pr-3 font-medium">Paket</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Nominal</th>
                  <th scope="col" className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {me.orders.map((o) => (
                  <tr key={o.id} className="border-b border-line last:border-b-0">
                    <td className="py-2 pr-3">{dateTime(o.created_at)}</td>
                    <td className="py-2 pr-3 font-mono">{o.id}</td>
                    <td className="py-2 pr-3">
                      {plans.find((p) => p.id === o.plan)?.name ?? o.plan}, {o.months} bulan
                    </td>
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
