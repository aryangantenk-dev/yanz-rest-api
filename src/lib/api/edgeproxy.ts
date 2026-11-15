import { HttpError } from "./types";

/**
 * Penerus permintaan ke situs sumber yang menolak IP server Vercel: Supabase Edge Function
 * di supabase/functions/film-proxy (GET /fetch?url=..., header x-proxy-key).
 * Env SANKA_PROXY_URL + SANKA_PROXY_KEY; nama fungsi dan env itu peninggalan versi lama.
 * Saat ini hanya dipakai kategori JKT48.
 */
export type ProxyOpts = {
  accept?: string;
  referer?: string;
  origin?: boolean;
  xhr?: boolean;
  /** Minta perantara menambahkan header X-Request-Id acak. */
  requestId?: boolean;
  timeoutMs?: number;
  /** Nama perantara di pesan galat. */
  label?: string;
};
export type ProxyResult = { status: number; finalUrl: string; type: string; text: string };

const ENV_URL = "SANKA_PROXY_URL";
const ENV_KEY = "SANKA_PROXY_KEY";

export function proxyConfigured(): boolean {
  return !!(process.env[ENV_URL] && process.env[ENV_KEY]);
}

export async function viaProxy(url: string, opts: ProxyOpts = {}): Promise<ProxyResult> {
  const label = opts.label ?? "Server perantara";
  const base = (process.env[ENV_URL] || "").trim().replace(/\/+$/, "");
  const key = (process.env[ENV_KEY] || "").trim();
  if (!base || !key) throw new HttpError(503, `Endpoint ini belum aktif: ${ENV_URL} dan ${ENV_KEY} belum diatur di server.`);

  const qs = new URLSearchParams({ url });
  if (opts.accept) qs.set("accept", opts.accept);
  if (opts.referer) qs.set("referer", opts.referer);
  if (opts.origin) qs.set("origin", "1");
  if (opts.xhr) qs.set("xhr", "1");
  if (opts.requestId) qs.set("rid", "1");

  let res: Response;
  try {
    res = await fetch(`${base}/fetch?${qs}`, {
      headers: { "x-proxy-key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 28000),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new HttpError(504, `${label} terlalu lama merespons.`);
    throw new HttpError(502, `${label} tidak bisa dihubungi.`);
  }
  const upstream = res.headers.get("x-upstream-status");
  if (!upstream) {
    // Jawaban berasal dari perantara itu sendiri, bukan dari situs sumber.
    if (res.status === 401) throw new HttpError(502, `Kunci ${label.toLowerCase()} tidak cocok (${ENV_KEY}).`);
    if (res.status === 400) throw new HttpError(502, `${label} menolak alamat sumber (di luar daftar izin).`);
    if (res.status === 504) throw new HttpError(504, "Situs sumber terlalu lama merespons.");
    throw new HttpError(502, `${label} gagal mengambil halaman sumber.`);
  }
  return { status: res.status, finalUrl: res.headers.get("x-final-url") || url, type: res.headers.get("content-type") || "", text: await res.text() };
}
