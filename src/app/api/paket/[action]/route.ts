import { NextResponse } from "next/server";
import { AUTH_ENABLED } from "@/lib/auth/config";
import { hit } from "@/lib/auth/limit";
import { authOrigin, sameSite } from "@/lib/auth/origin";
import { clearSessionCookie, isSecure, sessionUserId } from "@/lib/auth/session";
import { keyOwner, userById, type User } from "@/lib/auth/users";
import { ORDER_ID_RE, newOrderId, orderAttach, orderClose, orderGet, orderOpen, orderPaid, orderSync, ordersOf, publicOrder, type Order } from "@/lib/billing/orders";
import { FEE_ON_CUSTOMER, GATEWAY_READY, GatewayError, MAX_AMOUNT, MIN_AMOUNT, WEBHOOK_READY, createPayment, verifyWebhook } from "@/lib/billing/welper";
import { LIMIT_MAX, LIMIT_MIN, LIMIT_PLAN, LIMIT_PRICE, LIMIT_STEP, MAX_PLAN_DAYS, formatNumber, planById, planView } from "@/lib/plans";
import { SITE_CREATOR, SITE_NAME } from "@/lib/site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Rute paket untuk halaman /paket (bukan bagian dari API publik).
 *   GET  /api/paket/me                 paket akun yang sedang masuk, pemakaian hari ini, riwayat pesanan
 *   GET  /api/paket/status?order=ID    status satu pesanan (ikut dicocokkan dengan payment gateway)
 *   POST /api/paket/checkout           { plan, days } untuk paket, atau { plan: "limit", qty } untuk limit tambahan;
 *                                      membuat tagihan QRIS, jawabannya memuat payment_url
 *   POST /api/paket/webhook            notifikasi dari payment gateway (bertanda tangan)
 */
function json(status: number, body: Record<string, unknown>, setCookie?: string) {
  const res = NextResponse.json({ status: status < 400, creator: SITE_CREATOR, ...body }, { status, headers: { "cache-control": "no-store, private" } });
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, setCookie?: string) => json(status, { code: status, error, ...extra }, setCookie);

const STORE_DOWN = "Server akun sedang tidak dapat dihubungi. Coba lagi sebentar lagi.";

const planInfo = (user: User) => planView(user.plan, user.plan_expires_at, user.is_admin === true, user.extra_limit);

/** Akun yang sedang masuk, atau jawaban galat yang tinggal dikembalikan. */
async function signedIn(req: Request, what: string): Promise<User | NextResponse> {
  const id = AUTH_ENABLED ? sessionUserId(req) : null;
  if (!id) return fail(401, `Kamu belum masuk. Masuk dulu untuk ${what}.`);
  const user = await userById(id);
  if (!user || user.banned) return fail(401, `Sesi berakhir. Masuk lagi untuk ${what}.`, {}, clearSessionCookie(isSecure(req)));
  return user;
}

export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action !== "me" && action !== "status") return fail(404, "Aksi tidak dikenal.");
  try {
    let user = await signedIn(req, "melihat paket");
    if (user instanceof NextResponse) return user;

    if (action === "status") {
      const id = (new URL(req.url).searchParams.get("order") || "").trim().toUpperCase();
      if (!ORDER_ID_RE.test(id)) return fail(400, "Parameter 'order' wajib diisi dengan nomor pesanan.");
      const found = await orderGet(id);
      // Pesanan milik akun lain dijawab sama seperti pesanan yang tidak ada.
      if (!found || found.user_id !== user.id) return fail(404, "Pesanan tidak ditemukan.");
      const order = await orderSync(found);
      if (order.status === "paid" && found.status !== "paid") user = (await userById(user.id)) ?? user;
      return json(200, { order: publicOrder(order), plan: planInfo(user) });
    }

    let orders = await ordersOf(user.id, 10);
    // Cadangan bila webhook terlambat: cocokkan pesanan yang masih menunggu dengan gateway.
    const waiting = GATEWAY_READY ? orders.filter((o) => o.status === "pending").slice(0, 2) : [];
    if (waiting.length) {
      const synced = await Promise.all(waiting.map((o) => orderSync(o)));
      const changed = new Map(synced.filter((o, i) => o.status !== waiting[i].status).map((o) => [o.id, o] as const));
      if (changed.size) {
        orders = orders.map((o) => changed.get(o.id) ?? o);
        user = (await userById(user.id)) ?? user;
      }
    }
    // Pemakaian hari ini dibaca dari fungsi yang sama dengan pembatas kuota.
    const owner = user.username ? await keyOwner(user.api_key) : null;
    return json(200, {
      plan: planInfo(user),
      today: Math.max(0, Math.floor(Number(owner?.used_today) || 0)),
      // Pesanan yang gagal dibuat di gateway tidak pernah punya tagihan, jadi tidak ditampilkan.
      orders: orders.filter((o) => o.status !== "failed").map(publicOrder),
      payment: GATEWAY_READY,
      needsUsername: !user.username,
    });
  } catch (e) {
    console.error(`[paket/${action}]`, e);
    return fail(503, STORE_DOWN);
  }
}

async function readJson(req: Request, max: number): Promise<{ raw: string; body: Record<string, unknown> }> {
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    /* isi tidak terbaca: diperlakukan sebagai kosong */
  }
  if (raw.length > max) return { raw: "", body: {} };
  try {
    const body = JSON.parse(raw) as unknown;
    return { raw, body: body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {} };
  } catch {
    return { raw, body: {} };
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action === "webhook") return webhook(req);
  if (action !== "checkout") return fail(404, "Aksi tidak dikenal.");
  if (!sameSite(req)) return fail(403, "Permintaan ini hanya bisa dikirim dari halaman situs ini.");
  if (!AUTH_ENABLED) return fail(503, "Login belum diaktifkan di server ini.");

  try {
    const user = await signedIn(req, "membeli paket");
    if (user instanceof NextResponse) return user;
    if (!user.username) return fail(403, "Isi username dulu di halaman Akun sebelum membeli paket.");

    const { body } = await readJson(req, 2000);
    const planId = typeof body.plan === "string" ? body.plan : "";
    // Dua macam pembelian: limit tambahan (qty limit) atau paket harian (days hari).
    const topUp = planId === LIMIT_PLAN;
    const plan = topUp ? null : planById(planId);
    let days = 0;
    let qty = 0;
    let amount = 0;
    let what = "";
    if (topUp) {
      qty = Number(body.qty);
      if (!Number.isInteger(qty) || qty < LIMIT_MIN || qty > LIMIT_MAX || qty % LIMIT_STEP !== 0) {
        return fail(400, `Jumlah limit harus kelipatan ${formatNumber(LIMIT_STEP)}, dari ${formatNumber(LIMIT_MIN)} sampai ${formatNumber(LIMIT_MAX)}.`, { field: "qty" });
      }
      amount = qty * LIMIT_PRICE;
      what = `limit tambahan ${formatNumber(qty)} permintaan`;
    } else {
      if (!plan || plan.price <= 0) return fail(400, "Paket tidak dikenal.", { field: "plan" });
      days = Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > MAX_PLAN_DAYS) return fail(400, `Jumlah hari harus bilangan bulat dari 1 sampai ${MAX_PLAN_DAYS}.`, { field: "days" });
      amount = plan.price * days;
      what = `paket ${plan.name} ${days} hari`;
    }
    if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) return fail(400, `Nominal ini tidak bisa dibayar lewat QRIS. ${topUp ? "Ubah jumlah limitnya." : "Ubah jumlah harinya."}`, { field: topUp ? "qty" : "days" });
    if (!GATEWAY_READY) return fail(503, "Pembayaran belum diaktifkan di server ini. Hubungi owner untuk membeli paket.");

    const wait = hit("checkout", user.id, 8, 10 * 60_000);
    if (wait) return fail(429, `Terlalu banyak tagihan dibuat. Coba lagi dalam ${Math.ceil(wait / 60)} menit.`, { retry_after: wait });

    const opened = await orderOpen(newOrderId(), user.id, topUp ? LIMIT_PLAN : plan!.id, days, qty, amount);
    if (opened.status !== "ok") return fail(429, "Terlalu banyak tagihan dibuat dalam satu jam terakhir. Selesaikan tagihan yang ada atau coba lagi nanti.");
    let order: Order = opened.order;
    if (order.payment_url) return json(200, { order: publicOrder(order), payment_url: order.payment_url, reused: true });

    let pay;
    try {
      pay = await createPayment({
        amount,
        merchantRef: order.id,
        customerName: user.username,
        description: `${SITE_NAME} ${what}`,
        // Halaman bayar menambahkan ?ref=…&merchant_ref=…&status=… ke alamat ini.
        returnUrl: `${authOrigin(req)}/paket`,
      });
    } catch (e) {
      if (!(e instanceof GatewayError)) throw e;
      console.error("[paket/checkout] gateway:", e.status, e.code, e.message);
      await orderClose(order.id, "failed").catch(() => false);
      if (e.code === "too_many_pending" || e.code === "rate_limited") return fail(429, "Payment gateway sedang membatasi pembuatan tagihan. Coba lagi beberapa menit lagi.");
      if (e.code === "gateway_closed" || e.code === "gateway_unavailable") return fail(503, "Pembayaran QRIS sedang ditutup sementara oleh penyedianya. Coba lagi nanti.");
      if (e.code === "unreachable") return fail(504, "Payment gateway tidak dapat dihubungi. Coba lagi sebentar lagi.");
      return fail(502, "Tagihan gagal dibuat karena payment gateway bermasalah. Coba lagi nanti atau hubungi owner.");
    }
    if (pay.merchant_ref !== order.id || pay.amount !== amount || (pay.status === "pending" && !pay.payment_url)) {
      console.error("[paket/checkout] jawaban gateway tidak cocok dengan pesanan", order.id);
      await orderClose(order.id, "failed").catch(() => false);
      return fail(502, "Tagihan gagal dibuat karena jawaban payment gateway tidak sesuai. Coba lagi nanti.");
    }
    if (pay.status === "paid") {
      const res = await orderPaid(order.id, pay.ref, pay.amount);
      if (res.status === "paid" || res.status === "already") order = res.order;
      return json(200, { order: publicOrder(order), payment_url: "", reused: true });
    }
    if (pay.status !== "pending") {
      await orderClose(order.id, pay.status).catch(() => false);
      return fail(409, "Tagihan ini sudah tidak berlaku. Buat tagihan baru.");
    }
    order = (await orderAttach(order.id, pay)) ?? order;
    return json(200, { order: publicOrder(order), payment_url: pay.payment_url, reused: false, fee_on_customer: FEE_ON_CUSTOMER });
  } catch (e) {
    console.error("[paket/checkout]", e);
    return fail(503, STORE_DOWN);
  }
}

/**
 * Notifikasi dari payment gateway. Selalu dijawab 2xx begitu tanda tangannya sah dan datanya
 * sudah diproses, supaya gateway berhenti mengulang; hanya kegagalan di sisi kita (database)
 * yang dijawab 503 agar dikirim ulang.
 */
async function webhook(req: Request) {
  const done = (result: string) => NextResponse.json({ ok: true, result }, { headers: { "cache-control": "no-store" } });
  if (!WEBHOOK_READY) return fail(503, "Webhook belum dikonfigurasi di server ini.");
  const { raw, body } = await readJson(req, 20_000);
  if (!verifyWebhook(raw, req.headers.get("x-gateway-timestamp") || "", req.headers.get("x-gateway-signature") || "")) {
    return fail(401, "Tanda tangan webhook tidak sah.");
  }
  const event = typeof body.event === "string" ? body.event : req.headers.get("x-gateway-event") || "";
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
  const id = typeof data.merchant_ref === "string" ? data.merchant_ref : "";
  if (event !== "payment.paid" && event !== "payment.expired") return done("ignored");
  // Pembayaran yang bukan dibuat oleh situs ini (akun gateway yang sama dipakai di tempat lain).
  if (!ORDER_ID_RE.test(id)) return done("unknown_order");
  try {
    if (event === "payment.expired") {
      await orderClose(id, "expired");
      return done("expired");
    }
    const amount = Number(data.amount);
    const res = await orderPaid(id, typeof data.ref === "string" ? data.ref : "", Number.isFinite(amount) ? Math.round(amount) : -1);
    if (res.status === "mismatch") console.error("[paket/webhook] nominal tidak cocok untuk pesanan", id);
    return done(res.status);
  } catch (e) {
    console.error("[paket/webhook]", e);
    return fail(503, STORE_DOWN);
  }
}
