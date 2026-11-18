import crypto from "node:crypto";
import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { need } from "./helpers";

/**
 * Bypass safelink SafelinkU (sfl.gl).
 *
 * Alur situsnya: halaman gate `/id?verify` -> `POST /api/session` (butuh token yang
 * ditempel di belakang cookie XSRF-TOKEN) -> tunggu timer -> `POST /api/verify` ->
 * lanjut ke gate berikutnya -> `POST /api/go` yang mengembalikan tautan tujuan.
 * Tautan tujuan masih melewati beberapa halaman sfl.gl, jadi diikuti sampai domain lain.
 *
 * Cookie disimpan per host. Batas waktu per permintaan pendek supaya endpoint tetap
 * muat di batas waktu serverless (maks 120 detik).
 */

const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

const BASE_HEADERS: Record<string, string> = {
  "accept-language": "id-ID,id;q=0.9",
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8"',
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": '"Android"',
  "user-agent": UA,
};

const VIEWPORT = { width: 392, height: 687 };
const MAX_HOP = 10;
const MAX_ROUND = 5;
/** Penanda halaman gate: form verifikasi dengan parameter `id=verify`. */
const GATE_RE = /id=["']verify["']/i;

export class SflError extends Error {
  raw?: string;
  status: number;
  constructor(message: string, raw?: string, status = 502) {
    super(message);
    this.name = "SflError";
    this.raw = raw;
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isSflHost = (host: string) => /(^|\.)sfl\.gl$/i.test(host);

/** Kunci token `/api/session`. Nilainya acak dan hanya dipakai untuk menandai permintaan. */
const TOKEN_KEY = "4820296e36927b3c70c677d7e6b3941c020bfd8b5ddd5ba0573828f9f65413bc";

/** Cookie per host: Map<host, Map<nama, nilai>>. */
const jar = new Map<string, Map<string, string>>();

function cookieHeader(host: string): string {
  const store = jar.get(host);
  return store ? [...store].map(([k, v]) => `${k}=${v}`).join("; ") : "";
}

/** Simpan Set-Cookie; cookie yang dihapus (max-age=0) dibuang dari jar. */
function storeCookies(host: string, headers: Headers): void {
  const list = headers.getSetCookie?.() ?? [];
  if (!list.length) return;
  if (!jar.has(host)) jar.set(host, new Map());
  const store = jar.get(host)!;
  for (const c of list) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    if (i < 1) continue;
    const name = kv.slice(0, i).trim();
    const value = kv.slice(i + 1).trim();
    if (/max-age=0/i.test(c) || /expires=Thu, 01 Jan 1970/i.test(c)) store.delete(name);
    else store.set(name, value);
  }
}

type Hop = { url: string; status: number };

async function request(
  url: string,
  opts: { method?: "GET" | "POST"; json?: unknown; referer?: string } = {},
): Promise<{ status: number; location: string | null; text: string }> {
  const u = new URL(url);
  const headers: Record<string, string> = { ...BASE_HEADERS };
  const cookie = cookieHeader(u.host);
  if (cookie) headers.cookie = cookie;
  if (opts.referer) headers.referer = opts.referer;

  let body: string | undefined;
  if (opts.method === "POST") {
    headers.accept = "*/*";
    headers["content-type"] = "application/json";
    headers.origin = u.origin;
    headers["sec-fetch-dest"] = "empty";
    headers["sec-fetch-mode"] = "cors";
    headers["sec-fetch-site"] = "same-origin";
    body = JSON.stringify(opts.json ?? {});
  } else {
    headers.accept = "text/html,application/xhtml+xml,*/*;q=0.8";
    headers["upgrade-insecure-requests"] = "1";
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new SflError(`Gagal terhubung ke ${u.host}.`, why);
  }
  storeCookies(u.host, res.headers);
  return { status: res.status, location: res.headers.get("location"), text: await res.text().catch(() => "") };
}

/** Token sesi = cookie XSRF-TOKEN + penanda di belakangnya (maksimal 128 karakter). */
function makeToken(pageUrl: string): string {
  const host = new URL(pageUrl).host;
  const xsrf = jar.get(host)?.get("XSRF-TOKEN");
  if (!xsrf) {
    const names = jar.has(host) ? [...jar.get(host)!.keys()].join(",") : "";
    throw new SflError("Cookie XSRF-TOKEN tidak ditemukan.", `host=${host} cookies=[${names}]`);
  }
  const tail = `#${Buffer.from(TOKEN_KEY).toString("base64")}`;
  return decodeURIComponent(xsrf).slice(0, Math.max(0, 128 - tail.length)) + tail;
}

async function api(page: string, path: string, json: unknown, trace?: string[]): Promise<Record<string, unknown>> {
  const res = await request(new URL(path, page).href, { method: "POST", json, referer: page });
  trace?.push(`POST ${path} ${JSON.stringify(json)} -> ${res.status} ${res.text.slice(0, 400)}`);
  if (res.status < 200 || res.status >= 300) {
    if (res.status === 419) throw new SflError("Sesi/token ditolak server (419). Coba lagi.", `${path} :: ${res.text}`);
    if (res.status === 422) throw new SflError("Permintaan ditolak validasi server (422).", `${path} :: ${res.text}`);
    throw new SflError(`API ${path} ditolak (HTTP ${res.status}).`, res.text);
  }
  try {
    return JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    throw new SflError(`Jawaban ${path} bukan JSON.`, res.text);
  }
}

/** Tautan lanjutan yang ditulis di halaman: form GET, meta refresh, atau location.replace. */
function sniffBody(html: string, base: string): string | null {
  const form = html.match(/<form[^>]+action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
  if (form && !/method=["']?post/i.test((form[0].match(/^<form[^>]*>/i) ?? [""])[0])) {
    const u = new URL(form[1], base);
    for (const m of form[2].matchAll(/<input[^>]+>/gi)) {
      const name = m[0].match(/name=["']([^"']+)["']/i);
      const value = m[0].match(/value=["']([^"']*)["']/i);
      if (name) u.searchParams.set(name[1], value ? value[1] : "");
    }
    return u.href;
  }
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i);
  if (meta) return new URL(meta[1], base).href;
  const js = html.match(/(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
  if (js) return new URL(js[1], base).href;
  const rep = html.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
  if (rep) return new URL(rep[1], base).href;
  return null;
}

const SKIP_HOST = /(^|\.)(sfl\.gl|w3\.org|google\.com|googleapis\.com|gstatic\.com|cloudflare\.com|jquery\.com|facebook\.com|twitter\.com)$/i;

/** Tautan tujuan di halaman `/ready/go`: JSON `{url}`, tautan lanjutan, atau URL luar pertama. */
function sniffFinal(body: string, base: string): string | null {
  try {
    const j = JSON.parse(body) as { url?: string; target?: string; link?: string; redirect?: string };
    const u = j.url ?? j.target ?? j.link ?? j.redirect;
    if (u) return new URL(u, base).href;
  } catch {
    /* bukan JSON */
  }
  const hop = sniffBody(body, base);
  if (hop && hop !== base) return hop;
  for (const m of body.replace(/\\+\//g, "/").matchAll(/https?:\/\/[^\s"'<>\\)\]]+/gi)) {
    try {
      const u = new URL(m[0]);
      if (!SKIP_HOST.test(u.hostname)) return u.href;
    } catch {
      /* bukan URL utuh */
    }
  }
  return null;
}

/** Ikuti halaman sfl.gl sampai halaman gate verifikasi, atau sampai keluar ke domain tujuan. */
async function navigate(start: string, referer: string, chain: Hop[]): Promise<{ url: string; gate: boolean }> {
  let url = start;
  let prev = referer;
  for (let i = 0; i < MAX_HOP; i++) {
    if (!isSflHost(new URL(url).hostname)) return { url, gate: false };
    const res = await request(url, { referer: prev });
    chain.push({ url, status: res.status });
    if (res.status >= 300 && res.status < 400 && res.location) {
      prev = url;
      url = new URL(res.location, url).href;
      continue;
    }
    if (res.status >= 400) throw new SflError(`Server menolak permintaan (HTTP ${res.status}).`, `${url} :: ${res.text}`);
    if (GATE_RE.test(res.text)) return { url, gate: true };
    const next = sniffBody(res.text, url);
    if (next && next !== url) {
      prev = url;
      url = next;
      continue;
    }
    return { url, gate: false };
  }
  throw new SflError(`Pengalihan terlalu banyak (>${MAX_HOP}).`, chain.map((c) => c.url).join(" -> "));
}

/** Setelah `/api/go`: ikuti pengalihan sampai halaman tujuan yang sebenarnya. */
async function finalize(start: string, referer: string, chain: Hop[]): Promise<string> {
  let url = start;
  let prev = referer;
  let hops = 0;
  for (let i = 0; i < MAX_HOP; i++) {
    // Halaman perantara (redirect.php, /ready, dll.) ikut dilewati sampai halaman biasa.
    const intermediary = isSflHost(new URL(url).hostname) || /\/(redirect|go|ready)(\.php)?(\/|$)/i.test(new URL(url).pathname);
    if (!intermediary && hops > 0) return url;
    const res = await request(url, { referer: prev });
    hops++;
    chain.push({ url, status: res.status });
    if (res.status >= 300 && res.status < 400 && res.location) {
      prev = url;
      url = new URL(res.location, url).href;
      continue;
    }
    if (res.status >= 400) throw new SflError(`Server menolak permintaan (HTTP ${res.status}).`, `${url} :: ${res.text}`);
    const next = sniffFinal(res.text, url);
    if (!next || next === url) {
      // Sudah halaman biasa tanpa tautan lanjutan: ini tujuannya.
      if (!intermediary) return url;
      throw new SflError("Tujuan akhir tidak ditemukan di halaman perantara.", `${url} :: ${res.text}`);
    }
    prev = url;
    url = next;
  }
  throw new SflError("Pengalihan terlalu banyak di langkah terakhir.", chain.map((c) => c.url).join(" -> "));
}

export type SflResult = {
  /** Tautan tujuan akhir. */
  url: string;
  /** Host tujuan, mis. "contoh.com". */
  host: string;
  /** Halaman sfl.gl yang diperiksa, berurutan. */
  chain: Hop[];
  /** Jumlah putaran gate verifikasi yang dilewati. */
  rounds: number;
  /** Jejak panggilan API, dipakai saat mode debug. */
  trace: string[];
};

/** Tujuan akhir setelah `/api/go` atau bila sfl.gl sudah melewati halaman gate. */
async function finish(url: string, referer: string, chain: Hop[]): Promise<string> {
  const final = await finalize(url, referer, chain);
  const cleaned = new URL(final);
  cleaned.pathname = cleaned.pathname.replace(/\/{2,}/g, "/");
  return cleaned.href;
}

/** Buka satu tautan sfl.gl sampai tautan tujuannya ketemu. */
export async function resolveSfl(input: string): Promise<SflResult> {
  const startUrl = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const chain: Hop[] = [];
  const trace: string[] = [];
  let page = await navigate(startUrl, "", chain);
  let rounds = 0;

  for (let round = 0; round < MAX_ROUND; round++) {
    if (!page.gate) {
      // Halaman tidak memuat form verifikasi: tautan langsung dialihkan ke tujuan.
      if (!isSflHost(new URL(page.url).hostname)) {
        return { url: page.url, host: new URL(page.url).hostname, chain, rounds, trace };
      }
      throw new SflError("Halaman verifikasi safelink tidak ditemukan (mungkin strukturnya berubah).", chain.map((c) => `${c.url} (${c.status})`).join(" -> "));
    }
    rounds = round + 1;

    const session = await api(page.url, "/api/session", { _token: makeToken(page.url) }, trace);
    if (session.captcha || session.passcode) {
      throw new SflError("Tautan ini memakai captcha atau passcode, jadi belum bisa dibuka otomatis.", JSON.stringify(session), 422);
    }

    if (session.step === 1) {
      await sleep(12000);
      const verify = await api(page.url, "/api/verify", { _a: 0 }, trace);
      const next = new URL(typeof verify.target === "string" && verify.target ? verify.target : "/redirect.php", page.url).href;
      page = await navigate(next, page.url, chain);
      continue;
    }

    if (session.step === 2) {
      await sleep(5000);
      const key = Math.floor(Math.random() * 1000);
      const size = `${(VIEWPORT.width + key) * 2}.${(VIEWPORT.height + key) * 2}`;
      const go = await api(page.url, "/api/go", { key, size, ado: null }, trace);
      if (typeof go.url !== "string" || !go.url) throw new SflError("Jawaban /api/go tidak berisi url.", JSON.stringify(go));
      const final = await finish(new URL(go.url, page.url).href, page.url, chain);
      return { url: final, host: new URL(final).hostname, chain, rounds, trace };
    }

    // Langkah lanjutan atau jawaban tanpa `step`: lanjutkan dari halaman yang sedang terbuka.
    const next = typeof session.target === "string" && session.target ? session.target : page.url;
    page = await navigate(new URL(next, page.url).href, page.url, chain);
    if (!page.gate && !isSflHost(new URL(page.url).hostname)) {
      return { url: page.url, host: new URL(page.url).hostname, chain, rounds, trace };
    }
  }

  throw new SflError(`Putaran verifikasi terlalu banyak (>${MAX_ROUND}).`, chain.map((c) => c.url).join(" -> "));
}

export const sflEndpoints: Endpoint[] = [
  {
    category: "downloader",
    slug: "sfl",
    kind: "json",
    aliases: ["safelinku"],
    title: "Bypass SafelinkU (sfl.gl)",
    description:
      "Buka tautan safelink sfl.gl (SafelinkU) sampai tautan tujuannya ketemu, tanpa iklan dan tanpa klik manual. Endpoint menjalankan sendiri alur verifikasinya: ambil sesi, tunggu timer, lalu ikuti pengalihan sampai keluar dari sfl.gl. Butuh 15 sampai 40 detik karena timernya memang nyata. Belum bisa menembus tautan yang memakai captcha atau passcode.",
    params: [
      {
        name: "url",
        required: true,
        description: "Tautan sfl.gl yang mau dibuka, mis. https://sfl.gl/AbCdEf.",
        example: "https://sfl.gl/gOfplaB",
      },
    ],
    handler: async ({ sp }) => {
      const raw = need(sp, "url", 2000);
      const match = raw.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)*sfl\.gl(?:\/[^\s]*)?/i);
      if (!match) throw new HttpError(400, "Tautan harus dari domain sfl.gl.");
      let result: SflResult;
      try {
        result = await resolveSfl(match[0]);
      } catch (e) {
        if (e instanceof SflError) {
          console.error("[sfl]", e.message, e.raw ?? "");
          throw new HttpError(e.status, e.raw ? `${e.message} Detail: ${e.raw.slice(0, 300)}` : e.message);
        }
        throw e;
      }
      if (sp.get("debug") === "1") return { target: result.url, trace: result.trace };
      return {
        target: result.url,
        host: result.host,
        rounds: result.rounds,
        steps: result.chain.length,
        chain: result.chain.map((c) => c.url),
      };
    },
  },
];
