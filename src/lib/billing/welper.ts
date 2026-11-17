import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Klien payment gateway QRIS Welper (https://welper.web.id/gateway/docs).
 *
 *   WELPER_API_KEY          API key akun gateway (gwk_...). Tanpa ini pembelian paket nonaktif.
 *   WELPER_WEBHOOK_SECRET   Secret webhook (whsec_...), untuk memeriksa tanda tangan notifikasi.
 *   WELPER_FEE_BEARER       "customer" (bawaan: pembeli menanggung biaya QRIS) atau "merchant".
 *   WELPER_BASE_URL         Hanya untuk pengujian; bawaan https://welper.web.id/gateway/api/v1.
 */
const env = (name: string) => (process.env[name] || "").trim();

const BASE = (env("WELPER_BASE_URL") || "https://welper.web.id/gateway/api/v1").replace(/\/+$/, "");
const API_KEY = env("WELPER_API_KEY");
const WEBHOOK_SECRET = env("WELPER_WEBHOOK_SECRET");
const FEE_BEARER = env("WELPER_FEE_BEARER").toLowerCase() === "merchant" ? "merchant" : "customer";

/** Pembayaran bisa dibuat. */
export const GATEWAY_READY = !!API_KEY;
/** Notifikasi dari gateway bisa diperiksa keasliannya. */
export const WEBHOOK_READY = !!WEBHOOK_SECRET;
export const FEE_ON_CUSTOMER = FEE_BEARER === "customer";

/** Batas nominal satu pembayaran di gateway. */
export const MIN_AMOUNT = 1_000;
export const MAX_AMOUNT = 5_000_000;

export type GatewayStatus = "pending" | "paid" | "expired" | "canceled";

export type Payment = {
  ref: string;
  merchant_ref: string;
  status: GatewayStatus;
  amount: number;
  fee: number;
  total: number;
  payment_url: string;
  expires_at: string | null;
  paid_at: string | null;
};

export class GatewayError extends Error {
  constructor(
    /** Kode HTTP dari gateway; 0 bila gateway tidak bisa dihubungi atau jawabannya tidak terbaca. */
    readonly status: number,
    /** `error.code` dari gateway, mis. "too_many_pending". */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const int = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

function toPayment(d: Record<string, unknown>): Payment {
  const status = str(d.status);
  const ref = str(d.ref);
  if (!ref || !["pending", "paid", "expired", "canceled"].includes(status)) throw new GatewayError(0, "bad_response", "Jawaban payment gateway tidak dikenali.");
  const url = str(d.payment_url);
  return {
    ref,
    merchant_ref: str(d.merchant_ref),
    status: status as GatewayStatus,
    amount: int(d.amount),
    fee: int(d.fee),
    total: int(d.total),
    // Tautan ini nanti dibuka di browser pembeli, jadi hanya http(s) yang diterima.
    payment_url: /^https?:\/\//i.test(url) ? url : "",
    expires_at: str(d.expires_at) || null,
    paid_at: str(d.paid_at) || null,
  };
}

type Envelope = { success?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };

function parseBody(text: string): Envelope | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Envelope) : null;
  } catch {
    return null;
  }
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!API_KEY) throw new GatewayError(0, "not_configured", "Payment gateway belum dikonfigurasi.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${API_KEY}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch {
    throw new GatewayError(0, "unreachable", "Payment gateway tidak dapat dihubungi.");
  } finally {
    clearTimeout(timer);
  }
  const json = parseBody(text);
  if (!json) throw new GatewayError(res.status, "bad_response", `Payment gateway menjawab ${res.status} dengan isi yang tidak terbaca.`);
  if (!res.ok || json.success !== true || !json.data || typeof json.data !== "object") {
    throw new GatewayError(res.status, str(json.error?.code) || "error", str(json.error?.message) || `Payment gateway menjawab ${res.status}.`);
  }
  return json.data as Record<string, unknown>;
}

/**
 * Buat tagihan QRIS. Aman diulang: gateway mengembalikan tagihan yang sama untuk
 * `merchantRef` + `amount` yang sama selama masih menunggu.
 */
export async function createPayment(p: { amount: number; merchantRef: string; customerName: string; description: string; returnUrl: string }): Promise<Payment> {
  return toPayment(
    await call("POST", "/payments", {
      amount: p.amount,
      merchant_ref: p.merchantRef,
      customer_name: p.customerName.slice(0, 60),
      description: p.description.slice(0, 120),
      return_url: p.returnUrl,
      fee_bearer: FEE_BEARER,
    }),
  );
}

/** Status terbaru sebuah tagihan. `ref` boleh kode gateway (GW…) atau merchant_ref. */
export async function getPayment(ref: string): Promise<Payment> {
  return toPayment(await call("GET", `/payments/${encodeURIComponent(ref)}`));
}

/** Cek koneksi ke gateway (tanpa API key). */
export async function pingGateway(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${BASE}/ping`, { cache: "no-store", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Selisih waktu terbesar antara cap waktu webhook dan jam server ini, dalam detik. */
const WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Periksa tanda tangan webhook: `sha256=` + HMAC-SHA256(timestamp + "." + isi mentah).
 * `raw` harus isi permintaan persis seperti yang diterima (bukan hasil parse lalu stringify).
 */
export function verifyWebhook(raw: string, timestamp: string, signature: string, now = Date.now()): boolean {
  if (!WEBHOOK_SECRET || !/^\d{1,12}$/.test(timestamp) || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SEC) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex")}`);
  const given = Buffer.from(signature.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
