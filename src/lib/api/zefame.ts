/**
 * Zefame Free Services Scraper
 * Creator: IzzXd
 * Base: https://zefame.com/free-services
 * Saluran: https://whatsapp.com/channel/0029VbDyL6d9RZAh3JjEM325
 * Note: pliss guys jangan di klaim 100% buatan lu, lu boleh kok modifikasi trs share lagi tapi tolong jangan ilangin header creator sama ch-nya
 */

/*
 * Adaptasi skrip di atas menjadi endpoint yanz.api (TypeScript, tanpa berkas dan tanpa CLI).
 * Alur, alamat API, dan cara mengenali id video/post/username mengikuti skrip aslinya.
 *
 * Order di Zefame dijaga Cloudflare Turnstile. Tokennya didapat dari salah satu, berurutan:
 *  - parameter `token` yang dikirim pemanggil;
 *  - pemecah di VPS sendiri: EzSolver (https://github.com/ismoiloffS/EzSolver, MIT, buatan Ismoiloff)
 *    yang dipasang scripts/film-proxy/install.sh dengan SOLVER=1 dan dipanggil lewat film-proxy
 *    (POST /solve, env FILM_PROXY_URL + FILM_PROXY_KEY);
 *  - layanan pemecah Turnstile milik IzzXd, bila env IZZXD_APIKEY diisi (akunnya harus paket Pro).
 * Tanpa satu pun, endpoint order menjawab 503. Daftar layanan dan cek status tidak butuh token.
 */

import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { need, opt, parseHttpUrl } from "./helpers";

const SITE = "https://zefame.com";
const PAGE = `${SITE}/free-services`;
const API = "https://api.zefame.com/api_free.php";
const TURNSTILE_SITEKEY = "0x4AAAAAACWzOmyoRZoUyJWP";
const SOLVER = "https://api.izzxd.my.id/api/tools/cf-turnstile";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const HEADERS = { origin: SITE, referer: PAGE, "user-agent": UA, accept: "application/json, text/javascript, */*; q=0.01" };

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const numv = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------------------------------------ pengambilan */

type Reply = { http: number; success: boolean; message: string | null; data: J };

/** Panggil API Zefame. `form` diisi berarti POST (application/x-www-form-urlencoded). */
async function zf(query: string, form?: URLSearchParams, timeoutMs = 15000): Promise<Reply> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${API}${query}`, {
      method: form ? "POST" : "GET",
      headers: form ? { ...HEADERS, "content-type": "application/x-www-form-urlencoded; charset=UTF-8" } : HEADERS,
      body: form ? form.toString() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new HttpError(504, "Zefame terlalu lama merespons.");
    throw new HttpError(502, "Gagal menghubungi Zefame.");
  }
  let body: J;
  try {
    body = obj(JSON.parse(text));
  } catch {
    throw new HttpError(502, `Zefame mengirim respons yang tidak valid (HTTP ${res.status}).`);
  }
  return { http: res.status, success: body.success === true, message: str(body.message), data: obj(body.data) };
}

/* ---------------------------------------------------------------- layanan */

type Service = {
  id: number;
  platform: string;
  platform_key: string;
  name: string;
  quantity: number | null;
  interval: string | null;
  interval_seconds: number | null;
  limited: boolean;
  available: boolean;
  description: string | null;
  url: string | null;
};

const MIN = 60_000;
let cached: { at: number; list: Service[] } | null = null;

async function services(): Promise<Service[]> {
  if (cached && Date.now() - cached.at < 5 * MIN) return cached.list;
  const r = await zf("?action=config");
  if (!r.success) throw new HttpError(502, `Zefame tidak memberikan daftar layanan${r.message ? `: ${r.message}` : "."}`);
  const list: Service[] = [];
  for (const [key, raw] of Object.entries(r.data)) {
    const platform = obj(raw);
    for (const item of Array.isArray(platform.services) ? platform.services : []) {
      const s = obj(item);
      const id = numv(s.id);
      const name = str(s.name);
      if (id === null || !name) continue;
      const path = str(s.url);
      list.push({
        id,
        platform: str(platform.name) ?? key,
        platform_key: key.toLowerCase(),
        name,
        quantity: numv(s.quantity),
        interval: str(s.timer),
        interval_seconds: numv(s.timerSeconds),
        limited: s.badgeClass === "warning" || /^limit/i.test(str(s.badge) ?? ""),
        available: s.available !== false,
        description: str(s.description),
        url: path ? new URL(path, SITE).toString() : null,
      });
    }
  }
  if (!list.length) throw new HttpError(502, "Zefame mengirim daftar layanan yang kosong.");
  cached = { at: Date.now(), list };
  return list;
}

async function serviceOf(sp: URLSearchParams): Promise<Service> {
  const raw = need(sp, "service", 10);
  if (!/^\d{1,6}$/.test(raw)) throw new HttpError(400, "Parameter 'service' harus berupa id layanan (angka). Lihat daftarnya di tools/zefame-services.");
  const found = (await services()).find((s) => s.id === Number(raw));
  if (!found) throw new HttpError(404, `Layanan dengan id ${raw} tidak ada di Zefame. Lihat daftarnya di tools/zefame-services.`);
  return found;
}

const brief = (s: Service) => ({ id: s.id, platform: s.platform, name: s.name, quantity: s.quantity, interval: s.interval });

/* ----------------------------------------------------------------- target */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^@?[a-zA-Z0-9_.-]{1,64}$/;

function targetOf(sp: URLSearchParams): string {
  const link = need(sp, "link", 500);
  if (/^https?:\/\//i.test(link)) {
    parseHttpUrl(link);
    return link;
  }
  if (USERNAME_RE.test(link)) return link;
  throw new HttpError(400, "Parameter 'link' harus berupa tautan lengkap (diawali https://) atau username.");
}

function deviceOf(sp: URLSearchParams): string {
  const raw = opt(sp, "device");
  if (!raw) return crypto.randomUUID();
  if (!UUID_RE.test(raw)) throw new HttpError(400, "Parameter 'device' harus berupa UUID, contoh: 3f2b8c1e-7a4d-4e9b-9c6f-1d2a3b4c5d6e.");
  return raw.toLowerCase();
}

type Ids = { videoId: string; postId: string; username: string };

/** Kenali id video, id post, dan username dari tautan TikTok/Instagram/YouTube/X, atau dari username polos. */
function identifiers(link: string): Ids {
  let videoId = "";
  let postId = "";
  let username = "";

  const tiktok = /\/(?:video|photo)\/(\d+)/i.exec(link);
  if (tiktok) videoId = tiktok[1];

  const at = /@([a-zA-Z0-9_.-]+)/.exec(link);
  if (at) username = at[1];

  const igPost = /instagram\.com\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i.exec(link);
  if (igPost) postId = igPost[1];

  const igUser = /instagram\.com\/([a-zA-Z0-9_.-]+)\/?(?:\?|$)/i.exec(link);
  if (igUser && !username && !["reel", "reels", "p", "tv", "stories", "explore"].includes(igUser[1].toLowerCase())) username = igUser[1];

  const youtube = /(?:v=|\/shorts\/|\.be\/)([a-zA-Z0-9_-]{11})/i.exec(link);
  if (youtube) videoId = youtube[1];

  const tweet = /\/status\/(\d+)/i.exec(link);
  if (tweet) postId = tweet[1];

  if (!/^https?:/i.test(link) && USERNAME_RE.test(link)) username = link.replace(/^@/, "");

  return { videoId, postId, username };
}

/** Tautan pendek TikTok (vt.tiktok.com, tiktok.com/t/...) tidak memuat id video; Zefame yang menguraikannya. */
async function resolveIds(link: string): Promise<Ids> {
  const ids = identifiers(link);
  const isUrl = /^https?:\/\//i.test(link);
  const profileOnly = /tiktok\.com\/@[a-zA-Z0-9_.-]+\/?(?:\?.*)?$/i.test(link);
  if (isUrl && !ids.videoId && !profileOnly && /tiktok|tt\.site/i.test(link)) {
    try {
      const r = await zf("", new URLSearchParams({ action: "checkVideoId", link }), 12000);
      const id = str(r.data.videoId) ?? (numv(r.data.videoId) !== null ? String(r.data.videoId) : null);
      if (r.success && id) ids.videoId = id;
    } catch {
      // Tanpa id video, Zefame sendiri yang akan menolak di langkah berikutnya dengan pesannya.
    }
  }
  return ids;
}

function withIds(p: URLSearchParams, ids: Ids): URLSearchParams {
  if (ids.videoId) p.set("videoId", ids.videoId);
  if (ids.postId) p.set("postId", ids.postId);
  if (ids.username) p.set("username", ids.username);
  return p;
}

const idsOut = (ids: Ids) => ({ video_id: ids.videoId || null, post_id: ids.postId || null, username: ids.username || null });

function waitText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [h ? `${h} jam` : "", m ? `${m} menit` : "", !h && s % 60 ? `${s % 60} detik` : ""].filter(Boolean);
  return parts.join(" ") || "0 detik";
}

/** Waktu dari Zefame bisa berupa detik Unix atau teks; yang tidak dikenali dikembalikan apa adanya. */
function timeOut(v: unknown): string | null {
  const n = numv(v);
  if (n !== null && n > 1_000_000_000) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  return str(v) ?? (n !== null ? String(n) : null);
}

/** Galat untuk jawaban Zefame yang menolak: masa tunggu menjadi 429, sisanya membawa pesan Zefame. */
function refused(r: Reply, lead: string): HttpError {
  const wait = numv(r.data.timeLeft);
  if (wait !== null) return new HttpError(429, `Layanan ini masih dalam masa tunggu untuk target atau perangkat ini. Coba lagi dalam ${waitText(wait)}.`);
  if (r.http === 429) return new HttpError(429, "Zefame sedang membatasi permintaan. Coba lagi beberapa saat lagi.");
  if (r.http >= 500) return new HttpError(502, `Zefame sedang bermasalah (HTTP ${r.http}).`);
  const msg = r.message ?? str(r.data.message);
  return new HttpError(400, `${lead}${msg ? `: ${msg.slice(0, 300)}` : "."}`);
}

/* -------------------------------------------------------------- Turnstile */

const SOLVES_PER_MINUTE = 10;
const solves: number[] = [];

/** Batas pemakaian pemecah per menit, berlaku untuk pemecah mana pun. */
function takeSolveSlot(): void {
  const now = Date.now();
  while (solves.length && now - solves[0] > MIN) solves.shift();
  if (solves.length >= SOLVES_PER_MINUTE) throw new HttpError(429, "Order Zefame sedang padat. Coba lagi sekitar satu menit lagi.");
  solves.push(now);
}

const NO_TOKEN_HINT = "Sementara itu, kirim parameter 'token' berisi token Turnstile dari halaman zefame.com/free-services.";

/**
 * Minta token ke pemecah di VPS (EzSolver di belakang film-proxy).
 * "absent": VPS belum diatur atau pemecahnya belum dipasang; "unreachable": VPS tidak bisa dihubungi.
 */
async function solveOnVps(): Promise<{ token: string } | "absent" | "unreachable"> {
  const base = (process.env.FILM_PROXY_URL || "").trim().replace(/\/+$/, "");
  const key = (process.env.FILM_PROXY_KEY || "").trim();
  if (!base || !key) return "absent";

  let res: Response;
  let data: J;
  try {
    res = await fetch(`${base}/solve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-proxy-key": key },
      body: JSON.stringify({ sitekey: TURNSTILE_SITEKEY, siteurl: PAGE, timeout: 40 }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    data = obj(await res.json().catch(() => null));
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new HttpError(504, "Pemecah Turnstile di VPS terlalu lama merespons. Coba lagi.");
    return "unreachable";
  }
  const token = res.ok ? str(data.token) : null;
  if (token) return { token };

  const code = str(data.error) ?? "";
  // film-proxy versi lama tidak mengenal POST (501); versi baru tanpa pemecah menjawab solver_not_installed.
  if (code === "solver_not_installed" || (!code && [404, 405, 501].includes(res.status))) return "absent";
  // 502/530 tanpa isi JSON dari film-proxy berarti terowongannya yang putus, bukan pemecahnya yang gagal.
  if (!code) return "unreachable";
  if (code === "unauthorized") throw new HttpError(502, "Kunci server perantara tidak cocok (FILM_PROXY_KEY). Pemilik API perlu memeriksa konfigurasinya.");
  if (code === "busy") throw new HttpError(429, "Pemecah Turnstile sedang sibuk. Coba lagi beberapa detik lagi.");
  if (code === "timeout") throw new HttpError(504, "Pemecah Turnstile di VPS terlalu lama merespons. Coba lagi.");
  if (code === "solver_down") throw new HttpError(502, "Pemecah Turnstile di VPS sedang tidak berjalan. Pemilik API perlu menyalakannya lagi (sudo SOLVER=1 bash install.sh).");
  const detail = str(data.detail);
  throw new HttpError(502, `Pemecah Turnstile di VPS tidak mendapat token${detail ? `: ${detail.slice(0, 200)}.` : "."} Coba lagi.`);
}

/** Token otomatis: pemecah di VPS bila terpasang, selain itu layanan IzzXd bila kuncinya diisi. */
async function autoToken(): Promise<string> {
  takeSolveSlot();
  const vps = await solveOnVps();
  if (typeof vps === "object") return vps.token;

  const key = process.env.IZZXD_APIKEY?.trim();
  const unreachable = new HttpError(502, "Server perantara (VPS) tempat pemecah Turnstile berjalan tidak bisa dihubungi. Pastikan VPS dan layanan film-proxy masih hidup.");
  if (key) {
    try {
      return await solveTurnstile(key);
    } catch (e) {
      if (vps === "unreachable") throw unreachable;
      throw e;
    }
  }
  if (vps === "unreachable") throw unreachable;
  throw new HttpError(503, `Order otomatis belum aktif: pemecah Turnstile belum dipasang di server. ${NO_TOKEN_HINT}`);
}

/** Minta token Turnstile untuk halaman Zefame ke layanan pemecah IzzXd. Kuncinya tidak pernah ikut ke pesan galat. */
async function solveTurnstile(key: string): Promise<string> {

  const qs = new URLSearchParams({ apikey: key, url: PAGE, sitekey: TURNSTILE_SITEKEY, type: "min" });
  let res: Response;
  let data: J;
  try {
    res = await fetch(`${SOLVER}?${qs}`, { headers: { "user-agent": UA, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(70_000) });
    data = obj(await res.json().catch(() => null));
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new HttpError(504, "Layanan pemecah Turnstile terlalu lama merespons. Coba lagi.");
    throw new HttpError(502, "Gagal menghubungi layanan pemecah Turnstile.");
  }
  const token = data.status ? (str(obj(data.result).token) ?? str(data.token)) : null;
  if (token) return token;
  const msg = str(data.error) ?? str(data.message) ?? "";
  if (/paket|upgrade|premium|\bpro\b/i.test(msg)) {
    throw new HttpError(503, `Order otomatis belum aktif: layanan pemecah Turnstile (api.izzxd.my.id) hanya untuk paket Pro, sedangkan kunci di server ini belum Pro. ${NO_TOKEN_HINT}`);
  }
  if (res.status === 401 || res.status === 403 || /api\s*-?key/i.test(msg)) {
    throw new HttpError(502, "Kunci layanan pemecah Turnstile (IZZXD_APIKEY) ditolak. Pemilik API perlu memeriksa konfigurasinya.");
  }
  if (res.status === 429 || /limit/i.test(msg)) throw new HttpError(429, "Jatah layanan pemecah Turnstile sedang habis. Coba lagi nanti.");
  throw new HttpError(502, "Layanan pemecah Turnstile tidak memberikan token. Coba lagi.");
}

/* --------------------------------------------------------------- endpoint */

const PLATFORMS = ["tiktok", "instagram", "twitter", "facebook", "youtube", "telegram"];
const P_SERVICE = { name: "service", required: true, description: "Id layanan dari tools/zefame-services, contoh 229 untuk TikTok Views.", example: "229" };
const P_DEVICE = { name: "device", description: "Opsional: UUID perangkat. Masa tunggu Zefame dihitung per perangkat, jadi pakai nilai yang sama saat cek dan order. Default dibuat acak.", example: "" };

export const zefameEndpoints: Endpoint[] = [
  {
    category: "tools", slug: "zefame-services", kind: "json",
    title: "Zefame: Daftar Layanan Gratis",
    description: "Daftar layanan gratis Zefame (views, likes, followers, dan sejenisnya) untuk TikTok, Instagram, X/Twitter, Facebook, YouTube, dan Telegram: id layanan, jumlah per order, dan jeda antar-order.",
    params: [{ name: "platform", description: "Opsional: hanya layanan untuk satu platform.", example: "", options: PLATFORMS }],
    handler: async ({ sp }) => {
      const platform = opt(sp, "platform").toLowerCase();
      const all = await services();
      const known = [...new Set(all.map((s) => s.platform_key))];
      if (platform && !known.includes(platform)) throw new HttpError(400, `Parameter 'platform' tidak dikenal. Pilihan: ${known.join(", ")}.`);
      const list = platform ? all.filter((s) => s.platform_key === platform) : all;
      return {
        source: PAGE,
        total: list.length,
        platforms: known,
        services: list.map((s) => ({
          id: s.id,
          platform: s.platform,
          name: s.name,
          quantity: s.quantity,
          interval: s.interval,
          interval_seconds: s.interval_seconds,
          limited: s.limited,
          available: s.available,
          description: s.description,
          url: s.url,
        })),
      };
    },
  },
  {
    category: "tools", slug: "zefame-check", kind: "json",
    title: "Zefame: Cek Ketersediaan",
    description: "Cek apakah sebuah layanan gratis Zefame bisa dipesan sekarang untuk tautan atau username tertentu, atau masih dalam masa tunggu. Tidak mengirim order.",
    params: [
      P_SERVICE,
      { name: "link", required: true, description: "Tautan video/post/profil (diawali https://) atau username, sesuai layanannya.", example: "https://www.tiktok.com/@username/video/7234567890123456789" },
      P_DEVICE,
    ],
    handler: async ({ sp }) => {
      const service = await serviceOf(sp);
      const link = targetOf(sp);
      const device = deviceOf(sp);
      const ids = await resolveIds(link);
      const r = await zf(`?${withIds(new URLSearchParams({ action: "check", device, service: String(service.id) }), ids)}`);
      const wait = numv(r.data.timeLeft);
      return {
        source: PAGE,
        service: brief(service),
        target: link,
        ...idsOut(ids),
        device,
        allowed: r.success && r.data.allowed !== false,
        message: r.message ?? str(r.data.message),
        wait_seconds: wait,
        wait_text: wait !== null ? waitText(wait) : null,
        block_type: str(r.data.blockType),
        reset_time: timeOut(r.data.resetTime),
      };
    },
  },
  {
    category: "tools", slug: "zefame-order", kind: "json",
    title: "Zefame: Kirim Order Gratis",
    description: "Kirim order layanan gratis Zefame ke tautan atau username. Zefame menjaga order dengan Cloudflare Turnstile dan memberi masa tunggu per layanan; bila masih menunggu, endpoint menjawab 429.",
    params: [
      P_SERVICE,
      { name: "link", required: true, description: "Tautan video/post/profil (diawali https://) atau username yang menerima layanan.", example: "" },
      { name: "token", description: "Opsional: token Turnstile dari halaman zefame.com/free-services. Bila kosong, token diminta otomatis (hanya jika pemilik API sudah mengaktifkannya).", example: "" },
      P_DEVICE,
    ],
    handler: async ({ sp }) => {
      const service = await serviceOf(sp);
      const link = targetOf(sp);
      const device = deviceOf(sp);
      const given = opt(sp, "token");
      if (given.length > 4000) throw new HttpError(400, "Parameter 'token' terlalu panjang.");

      const ids = await resolveIds(link);

      // Sama seperti halaman Zefame: cek dulu, supaya token (dan jatah pemecahnya) tidak terbuang saat masih menunggu.
      const pre = await zf(`?${withIds(new URLSearchParams({ action: "check", device, service: String(service.id) }), ids)}`);
      if (!pre.success || pre.data.allowed === false) throw refused(pre, "Zefame belum menerima order ini");

      const token = given || (await autoToken());

      const form = withIds(new URLSearchParams({ service: String(service.id), link, uuid: device, cf_token: token }), ids);
      const r = await zf("?action=order", form, 30_000);
      if (!r.success) {
        if (numv(r.data.timeLeft) === null && /access denied/i.test(r.message ?? "")) {
          if (given) throw new HttpError(400, "Token Turnstile ditolak Zefame (salah, sudah dipakai, atau kedaluwarsa). Ambil token baru lalu coba lagi.");
          throw new HttpError(502, "Zefame menolak token Turnstile dari pemecah otomatis. Coba lagi.");
        }
        throw refused(r, "Zefame menolak order");
      }
      const orderId = r.data.orderId;
      return {
        source: PAGE,
        service: brief(service),
        target: link,
        ...idsOut(ids),
        device,
        order_id: typeof orderId === "string" || typeof orderId === "number" ? orderId : null,
        next_available: timeOut(r.data.nextAvailable),
        message: r.message ?? "Order terkirim.",
        token_source: given ? "parameter" : "otomatis",
      };
    },
  },
];
