import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { load } from "cheerio";
import { fetchJson, need, num, opt } from "./helpers";
import { browserHeaders, clean } from "./scrape";
import { proxyConfigured, viaProxy } from "./edgeproxy";

/*
  Sumber: https://wtr-lab.com (novel terjemahan Inggris, Next.js).
  Catatan: ide awal scraper ini berasal dari script publik "WTR-LAB Novel Scraper" oleh IzzXd
  (saluran WhatsApp 0029VbDyL6d9RZAh3JjEM325). Modul ini ditulis ulang mengikuti konvensi repo
  (endpoint, HttpError, validasi parameter) tanpa bagian proteksi header/evaluasi kode.

  Alur data:
  - daftar & peringkat: HTML Next.js → <script id="__NEXT_DATA__"> → props.pageProps.
  - detail seri: /en/novel/<rawId>/<slug> → pageProps.serie (serie_data, last_chapters).
  - daftar chapter: GET /api/chapters/<rawId>?start=1&end=500.
  - isi chapter: POST /api/reader/get {translate, language, raw_id, chapter_no} → content_url → JSON.
*/
const BASE = "https://wtr-lab.com";
const REFERER = `${BASE}/en`;
const COVER_HOSTS = /(^|\.)wtr-lab\.com$/i;

const ORDERS = ["update", "new", "name", "view", "reader", "chapter"] as const;
const RANKS = ["daily", "weekly", "monthly", "all"] as const;
const STATUSES = { 0: "Ongoing", 1: "Completed", 2: "Hiatus" } as Record<number, string>;

const novelUrl = (rawId: number | string, slug: string) => `${BASE}/en/novel/${rawId}/${slug || "novel"}`;
const chapterUrl = (rawId: number | string, slug: string, order: number | string) =>
  `${BASE}/en/novel/${rawId}/${slug || "novel"}/chapter-${order}`;

type Serie = {
  id?: number;
  slug?: string;
  status?: number;
  raw_id?: number;
  rating?: number | null;
  view?: number | null;
  chapter_count?: number | null;
  raw_chapter_count?: number | null;
  data?: { title?: string; author?: string; description?: string; image?: string | null };
  username?: string | null;
  verified?: boolean;
  genres?: string[];
  tags?: string[];
};

type Chapter = { id?: number; order?: number; title?: string; name?: string; locked?: boolean; updated_at?: string | null };

/** Bersihkan markup kecil: sisa format %{teks|...} dan penggaris baris. */
function tidy(text: string | null | undefined): string {
  return clean(String(text ?? "").replace(/%\{([^|}]+)\|[^}]+\}/g, "$1").replace(/\r/g, ""));
}

function statusLabel(code: number | undefined | null): string | null {
  return code === undefined || code === null ? null : STATUSES[code] ?? String(code);
}

function card(item: Serie) {
  const data = item.data ?? {};
  const slug = item.slug ?? null;
  const rawId = item.raw_id ?? null;
  return {
    id: item.id ?? null,
    raw_id: rawId,
    slug,
    title: tidy(data.title),
    author: tidy(data.author) || null,
    cover: data.image ?? null,
    rating: item.rating ?? null,
    views: item.view ?? null,
    chapters: item.chapter_count ?? item.raw_chapter_count ?? 0,
    status: statusLabel(item.status),
    description: tidy(data.description),
    url: rawId && slug ? novelUrl(rawId, slug) : null,
  };
}

/** Ambil props.pageProps dari HTML Next.js. */
function nextProps(html: string): Record<string, unknown> {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new HttpError(502, "Data halaman WTR-LAB tidak ditemukan (format situs berubah).");
  try {
    const parsed = JSON.parse(m[1]) as { props?: { pageProps?: Record<string, unknown> } };
    return parsed.props?.pageProps ?? {};
  } catch {
    throw new HttpError(502, "Data halaman WTR-LAB tidak bisa dibaca.");
  }
}

/*
  Cloudflare di WTR-LAB memberi cookie (mis. __cf_bm) saat halaman HTML dibuka, dan panggilan
  API POST /api/reader/get dari IP server ditolak 403 bila cookie itu tidak ikut. Cookie yang
  diterima dari GET disimpan singkat lalu ditempelkan ke panggilan API berikutnya.
*/
const jar = { cookie: "", at: 0 };
const JAR_TTL = 15 * 60 * 1000;

function rememberCookies(res: Response) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const pairs = new Map<string, string>();
  for (const raw of list) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) pairs.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  if (!pairs.size) return;
  // Simpan hanya cookie yang bukan sesi akun: cukup penanda bot/klarifikasi Cloudflare.
  const kept = [...pairs].filter(([k]) => /^(_|cf|wtr)/i.test(k)).map(([k, v]) => `${k}=${v}`);
  if (kept.length) {
    jar.cookie = kept.join("; ");
    jar.at = Date.now();
  }
}

function jarCookie(): string {
  return jar.cookie && Date.now() - jar.at < JAR_TTL ? jar.cookie : "";
}

async function html(path: string): Promise<string> {
  const res = await fetch(
    /^https?:\/\//i.test(path) ? path : `${BASE}${path}`,
    {
      headers: browserHeaders(REFERER, { accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...(jarCookie() ? { cookie: jarCookie() } : {}) }),
      cache: "no-store",
    },
  ).catch(() => null);
  if (!res) throw new HttpError(502, "Gagal menghubungi WTR-LAB.");
  if (res.status === 404) throw new HttpError(404, "Novel tidak ditemukan di WTR-LAB.");
  if (!res.ok) throw new HttpError(502, `WTR-LAB merespons dengan status ${res.status}.`);
  rememberCookies(res);
  return res.text();
}

/** Header untuk panggilan API JSON: sama seperti browser yang membuka halaman tadi. */
function apiHeaders(referer: string): Record<string, string> {
  const cookie = jarCookie();
  return browserHeaders(referer, { ...JSON_HEADERS, ...(cookie ? { cookie } : {}) });
}

const JSON_HEADERS = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
  origin: BASE,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};

type Target = { rawId: number; slug: string | null; chapter: number | null };

/** Terima raw id, slug, atau URL novel/chapter WTR-LAB. */
function parseTarget(raw: string): Target {
  const value = raw.trim();
  const fromUrl = value.match(/\/novel\/(\d+)(?:\/([^/?#]+))?(?:\/chapter-(\d+))?/i);
  if (fromUrl) return { rawId: Number(fromUrl[1]), slug: fromUrl[2] ?? null, chapter: fromUrl[3] ? Number(fromUrl[3]) : null };
  if (/^\d+$/.test(value)) return { rawId: Number(value), slug: null, chapter: null };
  const pair = value.match(/^(\d+)\/([^/?#]+)(?:\/chapter-(\d+))?$/i);
  if (pair) return { rawId: Number(pair[1]), slug: pair[2], chapter: pair[3] ? Number(pair[3]) : null };
  const slug = clean(String(raw).replace(/^\/+|\/+$/g, ""));
  if (!slug || /[?#\s<>"']/.test(slug)) throw new HttpError(400, "Parameter 'slug' tidak valid. Isi raw id, slug, atau URL novel WTR-LAB.");
  return { rawId: 0, slug, chapter: null };
}

/** Cari raw id dari slug bila pemanggil hanya memberi slug. */
async function resolveTarget(raw: string): Promise<Target> {
  const t = parseTarget(raw);
  if (t.rawId) return t;
  const found = await searchApi(t.slug!.replace(/-/g, " "));
  const exact = found.find((x) => x.slug === t.slug) ?? found[0];
  if (!exact?.raw_id) throw new HttpError(404, `Novel "${raw}" tidak ditemukan di WTR-LAB.`);
  return { rawId: Number(exact.raw_id), slug: exact.slug ?? t.slug, chapter: t.chapter };
}

type SearchHit = { id?: number; raw_id?: number; slug?: string; status?: number; data?: Serie["data"]; chapter_count?: number; rating?: number | null; view?: number | null };

async function searchApi(query: string): Promise<SearchHit[]> {
  const res = await fetchJson<{ success?: boolean; data?: SearchHit[] }>(
    `${BASE}/api/search`,
    { method: "POST", headers: apiHeaders(REFERER), body: JSON.stringify({ text: query }) },
    20000,
  );
  if (res?.success === false) throw new HttpError(502, "Pencarian WTR-LAB ditolak server sumber.");
  return Array.isArray(res?.data) ? res.data : [];
}

/** Semua chapter (dipaginasi 500 per permintaan, sama seperti situsnya). */
async function allChapters(rawId: number, total: number): Promise<Chapter[]> {
  const out: Chapter[] = [];
  const limit = Math.min(Math.max(total || 500, 1), 20000);
  for (let start = 1; start <= limit; start += 500) {
    const end = Math.min(limit, start + 499);
    const res = await fetchJson<{ chapters?: Chapter[] }>(
      `${BASE}/api/chapters/${rawId}?start=${start}&end=${end}`,
      { headers: apiHeaders(REFERER) },
      20000,
    );
    const batch = Array.isArray(res?.chapters) ? res.chapters : [];
    out.push(...batch);
    if (batch.length < end - start + 1) break;
  }
  return out;
}

function chapterEntry(rawId: number, slug: string, ch: Chapter) {
  return {
    order: ch.order ?? null,
    id: ch.id ?? null,
    title: tidy(ch.title) || `Chapter ${ch.order ?? ""}`.trim(),
    native_name: tidy(ch.name) || null,
    locked: Boolean(ch.locked),
    updated_at: ch.updated_at ?? null,
    url: ch.order ? chapterUrl(rawId, slug, ch.order) : null,
  };
}

async function loadSerie(target: string) {
  const t = await resolveTarget(target);
  const raw = await html(`/en/novel/${t.rawId}/${t.slug || "novel"}`);
  const page = nextProps(raw);
  const serie = (page.serie ?? {}) as { serie_data?: Serie; ranks?: unknown; last_chapters?: Chapter[] };
  const data = serie.serie_data;
  if (!data) throw new HttpError(502, "Metadata novel tidak terbaca dari WTR-LAB.");
  const rawId = Number(data.raw_id ?? t.rawId);
  const slug = data.slug ?? t.slug ?? "novel";
  const total = Number(data.chapter_count ?? data.raw_chapter_count ?? 0);
  const chapters = (await allChapters(rawId, total).catch(() => [])).map((c) => chapterEntry(rawId, slug, c));
  return {
    target: { ...t, rawId, slug },
    serie: data,
    chapters,
    genres: genreLabels(raw, data.genres),
    tags: Array.isArray(page.tags) ? (page.tags as { title?: string }[]).map((x) => x.title).filter((x): x is string => Boolean(x)) : [],
    ranks: serie.ranks ?? null,
  };
}

/** Genre di serie_data berupa angka (id); labelnya diambil dari tautan /en/novel-list?genre=<id>. */
function genreLabels(html: string, ids: unknown): string[] {
  const $ = load(html);
  const byId = new Map<string, string>();
  $('a[href*="genre="]').each((_, a) => {
    const el = $(a);
    const id = (el.attr("href") ?? "").match(/genre=(\d+)/)?.[1];
    const name = tidy(el.text()).toLowerCase();
    if (id && name && !byId.has(id)) byId.set(id, name);
  });
  if (Array.isArray(ids)) {
    const mapped = ids.map((id) => byId.get(String(id))).filter((x): x is string => Boolean(x));
    if (mapped.length) return mapped;
  }
  return [...byId.values()];
}

/**
 * Panggil /api/reader/get dengan beberapa varian header. Cloudflare di WTR-LAB kadang menerima
 * satu kombinasi dan menolak yang lain untuk IP pusat data; varian dicoba berurutan dan yang
 * berhasil dipakai. Bila semuanya ditolak, pesan galat memuat status tiap varian.
 */
type ReaderReply = {
  success?: boolean;
  error?: string;
  message?: string;
  code?: string;
  requireTurnstile?: boolean;
  content_url?: string;
  chapter?: Chapter & { char_count?: number };
};

const READER_VARIANTS: { name: string; headers: (referer: string) => Record<string, string> }[] = [
  { name: "browser", headers: (r) => apiHeaders(r) },
  {
    name: "minimal",
    headers: (r) => ({ "content-type": "application/json", accept: "application/json", referer: r }),
  },
  {
    name: "xhr",
    headers: (r) => ({
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      referer: r,
      origin: BASE,
      "x-requested-with": "XMLHttpRequest",
    }),
  },
  {
    name: "tanpa-referer",
    headers: () => ({ "content-type": "application/json", accept: "application/json" }),
  },
];

/** Ambil JSON lewat server perantara (edgeproxy) bila situs sumber menolak IP server. */
async function proxyJson<T>(url: string, opts: Parameters<typeof viaProxy>[1]): Promise<T | null> {
  const relay = await viaProxy(url, { label: "Server perantara", accept: "application/json", ...opts });
  if (relay.status < 200 || relay.status >= 300) return null;
  try {
    return JSON.parse(relay.text) as T;
  } catch {
    return null;
  }
}

/**
 * Cookie yang diterbitkan Cloudflare untuk IP server perantara. Perantara diblokir 403 pada
 * POST /api/reader/get bila belum pernah membuka halaman lewat jalur yang sama, jadi halaman
 * novel dibuka dulu dan cookie hasilnya dipakai pada panggilan berikutnya.
 */
let relayCookie = { value: "", at: 0 };

async function relayWarm(url: string): Promise<void> {
  const fresh = relayCookie.value && Date.now() - relayCookie.at < JAR_TTL;
  const referer = `${BASE}/en`;
  for (const target of fresh ? [] : [`${BASE}/en`, url]) {
    const relay = await viaProxy(target, {
      label: "Server perantara",
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      referer,
      cookie: relayCookie.value || undefined,
      timeoutMs: 25000,
    }).catch(() => null);
    const setCookie = relay?.setCookie ?? "";
    if (setCookie) {
      relayCookie = { value: setCookie, at: Date.now() };
    }
  }
}

async function readerGet(referer: string, body: unknown): Promise<ReaderReply> {
  const notes: string[] = [];
  for (const variant of READER_VARIANTS) {
    try {
      const res = await fetchJson<ReaderReply>(
        `${BASE}/api/reader/get`,
        { method: "POST", headers: variant.headers(referer), body: JSON.stringify(body) },
        25000,
      );
      return res;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      notes.push(`${variant.name}: ${e.status}`);
      // Galat 4xx selain 403 berarti permintaannya sampai ke aplikasi (mis. chapter terkunci).
      if (e.status < 500 && e.status !== 403) throw e;
    }
  }
  // Vercel diblokir Cloudflare; server perantara (Supabase Edge Function) dipakai sebagai jalan lain.
  if (proxyConfigured()) {
    await relayWarm(referer).catch(() => undefined);
    const call = () =>
      viaProxy(`${BASE}/api/reader/get`, {
        label: "Server perantara",
        accept: "application/json",
        referer,
        origin: true,
        xhr: true,
        body: JSON.stringify(body),
        cookie: relayCookie.value || undefined,
        timeoutMs: 30000,
      }).catch((e: unknown) => ({ status: e instanceof HttpError ? e.status : 0, text: "", type: "", finalUrl: "", setCookie: "" }));
    let relay = await call();
    // Cookie Cloudflare bisa kedaluwarsa: segarkan sekali lalu ulangi.
    if (relay.status === 403) {
      relayCookie = { value: "", at: 0 };
      await relayWarm(referer).catch(() => undefined);
      relay = await call();
    }
    notes.push(`perantara: ${relay.status}`);
    if (relay.status >= 200 && relay.status < 300) {
      try {
        return JSON.parse(relay.text) as ReaderReply;
      } catch {
        notes.push("perantara: jawaban bukan JSON");
      }
    }
  }
  throw new HttpError(
    502,
    `Server sumber menolak permintaan baca chapter (${notes.join(", ")}). WTR-LAB memblokir akses dari luar browser; coba lagi nanti atau buka chapter langsung di situsnya.`,
  );
}

/**
 * Tandai langkah mana yang gagal. Pesan galat dari fetchJson sudah menyebut status; awalan ini
 * membuat penyebab 403 di situs sumber (panggilan API atau berkas isi) langsung kelihatan.
 */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof HttpError && e.status >= 500) throw new HttpError(e.status, `[${label}] ${e.message}`);
    throw e;
  }
}

/** Id chapter (bukan nomor urut) yang dipakai klien WTR-LAB saat memanggil /api/reader/get. */
async function findChapter(rawId: number, order: number): Promise<Chapter | null> {
  const res = await fetchJson<{ chapters?: Chapter[] }>(
    `${BASE}/api/chapters/${rawId}?start=${order}&end=${order}`,
    { headers: apiHeaders(REFERER) },
    20000,
  ).catch(() => null);
  return (Array.isArray(res?.chapters) ? res.chapters.find((c) => c.order === order) : null) ?? null;
}

async function findChapterId(rawId: number, order: number): Promise<number | null> {
  const res = await fetchJson<{ chapters?: Chapter[] }>(
    `${BASE}/api/chapters/${rawId}?start=${order}&end=${order}`,
    { headers: apiHeaders(REFERER) },
    20000,
  ).catch(() => null);
  const hit = Array.isArray(res?.chapters) ? res.chapters.find((c) => c.order === order) : null;
  return hit?.id ?? null;
}

/** Isi satu chapter lewat API situs: reader/get → content_url → paragraf. */
async function chapterViaApi(rawId: number, slug: string, order: number) {
  const referer = chapterUrl(rawId, slug, order);
  // Pastikan cookie Cloudflare terisi (GET halaman chapter) sebelum memanggil API baca.
  if (!jarCookie()) await html(`/en/novel/${rawId}/${slug || "novel"}/chapter-${order}`).catch(() => "");
  const chapterId = await findChapterId(rawId, order);
  const payloadBody = chapterId
    ? { translate: "ai", language: "en", chapter_id: chapterId, raw_id: rawId }
    : { translate: "ai", language: "en", raw_id: rawId, chapter_no: order };
  const reader = await step("reader/get", () => readerGet(referer, payloadBody));

  if (!reader?.success) {
    if (reader?.requireTurnstile) throw new HttpError(503, "Chapter ini sedang dilindungi Cloudflare Turnstile di situs sumber. Coba lagi nanti.");
    if (reader?.code === "CHAPTER_LOCKED") throw new HttpError(403, `Chapter ${order} terkunci di WTR-LAB (butuh akun/unlock).`);
    throw new HttpError(502, reader?.error || reader?.message || `Gagal memuat chapter ${order}.`);
  }
  if (!reader.content_url) throw new HttpError(502, `Isi chapter ${order} belum tersedia di WTR-LAB.`);

  type ContentReply = { data?: { data?: { body?: unknown; glossary_data?: { terms?: unknown } } } };
  const contentUrl = /^https?:\/\//i.test(reader.content_url) ? reader.content_url : `${BASE}${reader.content_url}`;
  const payload = await step("content", async (): Promise<ContentReply> => {
    const direct = await fetchJson<ContentReply>(contentUrl, { headers: apiHeaders(referer) }, 25000).catch(() => null);
    if (direct?.data) return direct;
    if (proxyConfigured()) {
      await relayWarm(contentUrl).catch(() => undefined);
      const relay = await proxyJson<ContentReply>(contentUrl, {
        referer,
        origin: true,
        xhr: true,
        cookie: relayCookie.value || undefined,
        timeoutMs: 30000,
      }).catch(() => null);
      if (relay?.data) return relay;
    }
    throw new HttpError(502, "Server sumber tidak mengirim isi chapter (diblokir atau sedang sibuk). Coba chapter lain atau ulangi nanti.");
  });
  const inner = payload?.data?.data ?? {};
  const terms = (inner.glossary_data?.terms ?? []) as unknown[];
  const body = Array.isArray(inner.body) ? inner.body : [];

  // Setiap baris bisa memuat rujukan glosarium ※<index>[⛬〓]; ganti dengan istilah aslinya.
  const paragraphs: string[] = [];
  for (const line of body) {
    if (typeof line !== "string" || /^\s*\[(?:part:[^\]]+|image)\]\s*$/i.test(line)) continue;
    const filled = Array.isArray(terms) && terms.length
      ? line.replace(/※(\d+)[⛬〓]/g, (full, idx: string) => {
          const entry = terms[Number(idx)] as [string] | undefined;
          return entry?.[0] ? String(entry[0]).replace(/_/g, "") : full;
        })
      : line;
    const text = tidy(filled);
    if (text) paragraphs.push(text);
  }

  return {
    raw_id: rawId,
    slug,
    chapter: reader.chapter?.order ?? order,
    chapter_id: reader.chapter?.id ?? null,
    title: tidy(reader.chapter?.title) || `Chapter ${order}`,
    url: referer,
    characters: reader.chapter?.char_count ?? null,
    paragraphs: paragraphs.length,
    navigation: {
      prev: order > 1 ? chapterUrl(rawId, slug, order - 1) : null,
      next: chapterUrl(rawId, slug, order + 1),
    },
    content: paragraphs.join("\n\n"),
  };
}

/*
  Jalan terakhir: pembaca pihak ketiga yang menjalankan JavaScript (r.jina.ai). Cloudflare
  WTR-LAB memblokir IP data center (Vercel, Supabase) pada /api/reader/get, sementara halaman
  chapter tetap bisa dibaca lewat perender ini. Dipakai hanya bila semua jalur API gagal.
*/
const READER_RENDER = "https://r.jina.ai/";

type Rendered = { title: string | null; paragraphs: string[] };

/** Bersihkan markdown hasil perender menjadi paragraf teks. */
function renderParagraphs(text: string): Rendered {
  const start = text.indexOf("Markdown Content:");
  const body = start >= 0 ? text.slice(start + "Markdown Content:".length) : text;
  let title: string | null = null;
  const paragraphs: string[] = [];
  for (const raw of body.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    if (/^(title|url source|final url|published time|warning|markdown content):/i.test(line)) continue;
    if (/^\*\*[^*]{1,160}\*\*$/.test(line) && !title) {
      const only = line.replace(/\*\*/g, "").trim();
      // Baris tebal di awal biasanya judul chapter; kalau terlalu panjang, itu paragraf.
      if (only.length <= 120) {
        title = tidy(only);
        continue;
      }
    }
    if (/^!\[/.test(line) || /adform|monetixads|prebid|doubleclick|googlesyndication/i.test(line)) continue;
    line = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line) paragraphs.push(tidy(line));
  }
  return { title, paragraphs };
}

async function chapterViaRender(url: string): Promise<Rendered> {
  const res = await fetch(`${READER_RENDER}${url}`, {
    headers: { "user-agent": browserHeaders(REFERER)["user-agent"], accept: "text/plain" },
    cache: "no-store",
    signal: AbortSignal.timeout(50000),
  });
  if (!res.ok) throw new HttpError(502, `Pembaca cadangan merespons dengan status ${res.status}.`);
  return renderParagraphs(await res.text());
}

/** Isi satu chapter: API situs lebih dulu, perender pihak ketiga bila diblokir. */
async function chapterContent(rawId: number, slug: string, order: number) {
  const referer = chapterUrl(rawId, slug, order);
  let firstError: unknown = null;
  try {
    return await chapterViaApi(rawId, slug, order);
  } catch (e) {
    firstError = e;
    // Chapter terkunci/404 bukan soal blokir: jangan cari jalan lain.
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) throw e;
  }

  const rendered = await chapterViaRender(referer).catch(() => null);
  if (!rendered || rendered.paragraphs.length < 3) throw firstError;

  // Judul resmi diambil dari daftar chapter situs; judul hasil perender hanya cadangan karena
  // kadang memuat penomoran versi mesin penerjemah.
  const meta = await findChapter(rawId, order).catch(() => null);

  return {
    raw_id: rawId,
    slug,
    chapter: order,
    chapter_id: meta?.id ?? null,
    title: tidy(meta?.title) || rendered.title || `Chapter ${order}`,
    url: referer,
    characters: rendered.paragraphs.join(" ").length,
    paragraphs: rendered.paragraphs.length,
    navigation: {
      prev: order > 1 ? chapterUrl(rawId, slug, order - 1) : null,
      next: chapterUrl(rawId, slug, order + 1),
    },
    source: "render",
    content: rendered.paragraphs.join("\n\n"),
  };
}

export const novelEndpoints: Endpoint[] = [
  {
    category: "novel",
    slug: "latest",
    kind: "json",
    title: "Novel Terbaru",
    description: "Daftar novel WTR-LAB yang baru diperbarui atau baru ditambahkan, lengkap dengan judul, penulis, rating, jumlah chapter, status, dan sampul.",
    params: [
      { name: "page", description: "Nomor halaman (1-500). Satu halaman berisi 10 novel.", example: "1" },
      { name: "order", description: "Urutan daftar: update (baru diperbarui), new (baru ditambahkan), name, view, reader, atau chapter.", example: "update", options: [...ORDERS] },
    ],
    handler: async ({ sp }) => {
      const page = Math.floor(num(sp, "page", 1, 1, 500));
      const order = (opt(sp, "order") || "update").toLowerCase();
      if (!ORDERS.includes(order as (typeof ORDERS)[number])) {
        throw new HttpError(400, `Parameter 'order' harus salah satu: ${ORDERS.join(", ")}.`);
      }
      const props = nextProps(await html(`/en/novel-list?orderBy=${encodeURIComponent(order)}&page=${page}`));
      const items = (Array.isArray(props.series) ? (props.series as Serie[]) : []).map(card);
      return { source: BASE, page, order, total_catalog: props.count ?? null, total: items.length, items };
    },
  },
  {
    category: "novel",
    slug: "ranking",
    kind: "json",
    title: "Peringkat Novel",
    description: "Peringkat novel WTR-LAB harian, mingguan, bulanan, atau sepanjang masa beserta nomor peringkatnya.",
    params: [
      { name: "type", description: "Jenis peringkat: daily, weekly, monthly, atau all.", example: "daily", options: [...RANKS] },
      { name: "page", description: "Nomor halaman (1-500). Satu halaman berisi 10 novel.", example: "1" },
    ],
    handler: async ({ sp }) => {
      const type = (opt(sp, "type") || "daily").toLowerCase();
      if (!RANKS.includes(type as (typeof RANKS)[number])) throw new HttpError(400, `Parameter 'type' harus salah satu: ${RANKS.join(", ")}.`);
      const page = Math.floor(num(sp, "page", 1, 1, 500));
      const props = nextProps(await html(`/en/ranking/${type}?page=${page}`));
      const list = Array.isArray(props.list) ? (props.list as Serie[]) : [];
      const items = list.map((item, i) => ({ rank: (page - 1) * list.length + i + 1, ...card(item) }));
      return { source: `${BASE}/en/ranking/${type}`, type, page, total_catalog: props.count ?? null, total: items.length, items };
    },
  },
  {
    category: "novel",
    slug: "search",
    kind: "json",
    title: "Cari Novel",
    description: "Cari novel terjemahan di WTR-LAB berdasarkan judul. Hasil berisi raw_id dan slug untuk endpoint detail dan chapter.",
    params: [
      { name: "q", required: true, description: "Kata kunci judul novel.", example: "renegade immortal" },
      { name: "limit", description: "Jumlah hasil maksimal (1-50, bawaan 20).", example: "10" },
    ],
    handler: async ({ sp }) => {
      const q = need(sp, "q", 120);
      const limit = Math.floor(num(sp, "limit", 20, 1, 50));
      const hits = await searchApi(q);
      const items = hits.slice(0, limit).map(card);
      return { source: BASE, query: q, total: items.length, items };
    },
  },
  {
    category: "novel",
    slug: "list",
    kind: "json",
    title: "Jelajahi Novel",
    description: "Telusuri katalog WTR-LAB dengan filter genre, status, dan urutan. Mendukung halaman.",
    params: [
      { name: "genre", description: "Genre novel, mis. fantasy, action, romance, sci-fi.", example: "fantasy" },
      { name: "status", description: "Status terjemahan: 0 (Ongoing), 1 (Completed), atau 2 (Hiatus).", example: "1" },
      { name: "order", description: "Urutan daftar: update, new, name, view, reader, atau chapter.", example: "view", options: [...ORDERS] },
      { name: "asc", description: "1 untuk urutan menaik, 0 untuk menurun (bawaan 0).", example: "0" },
      { name: "page", description: "Nomor halaman (1-500).", example: "1" },
    ],
    handler: async ({ sp }) => {
      const qs = new URLSearchParams();
      const genre = opt(sp, "genre");
      if (genre) qs.set("genre", clean(String(genre)).toLowerCase().replace(/\s+/g, "-"));
      if (opt(sp, "status")) qs.set("status", String(Math.floor(num(sp, "status", 0, 0, 2))));
      const order = (opt(sp, "order") || "update").toLowerCase();
      if (!ORDERS.includes(order as (typeof ORDERS)[number])) throw new HttpError(400, `Parameter 'order' harus salah satu: ${ORDERS.join(", ")}.`);
      qs.set("orderBy", order);
      qs.set("asc", opt(sp, "asc") ? String(Math.floor(num(sp, "asc", 0, 0, 1))) : "0");
      const page = Math.floor(num(sp, "page", 1, 1, 500));
      qs.set("page", String(page));
      const props = nextProps(await html(`/en/novel-list?${qs.toString()}`));
      const items = (Array.isArray(props.series) ? (props.series as Serie[]) : []).map(card);
      const total = Number(props.count ?? 0);
      return {
        source: BASE,
        page,
        has_next: page * 10 < total,
        filter: { genre: qs.get("genre"), status: qs.get("status"), order, asc: qs.get("asc") === "1" },
        total_catalog: Number.isFinite(total) ? total : null,
        total: items.length,
        items,
      };
    },
  },
  {
    category: "novel",
    slug: "genre",
    kind: "json",
    title: "Daftar Genre Novel",
    description: "Semua genre novel yang tersedia di WTR-LAB, siap dipakai sebagai parameter genre di endpoint list.",
    params: [],
    handler: async () => {
      const genres = [
        "action", "adult", "adventure", "comedy", "drama", "ecchi", "erciyuan", "fan-fiction", "fantasy", "game",
        "gender-bender", "harem", "historical", "horror", "josei", "martial-arts", "mature", "mecha", "military",
        "mystery", "psychological", "romance", "school-life", "sci-fi", "seinen", "shoujo", "shoujo-ai", "shounen",
        "shounen-ai", "slice-of-life", "smut", "sports", "supernatural", "suspense", "xianxia", "xuanhuan",
      ];
      return {
        source: BASE,
        total: genres.length,
        genres: genres.map((slug) => ({ slug, name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) })),
      };
    },
  },
  {
    category: "novel",
    slug: "detail",
    kind: "json",
    title: "Detail Novel",
    description: "Metadata lengkap satu novel WTR-LAB: judul, penulis, status, rating, jumlah pembaca, genre, tag, sinopsis, sampul, dan daftar seluruh chapter.",
    params: [{ name: "slug", required: true, description: "raw_id, slug, atau URL novel WTR-LAB.", example: "106254" }],
    handler: async ({ sp }) => {
      const { target, serie, chapters, genres, tags, ranks } = await loadSerie(need(sp, "slug", 400));
      const first = chapters.find((c) => c.order === 1) ?? chapters[0] ?? null;
      const last = chapters.reduce<(typeof chapters)[number] | null>((acc, c) => (!acc || (c.order ?? 0) > (acc.order ?? 0) ? c : acc), null);
      return {
        source: novelUrl(target.rawId, target.slug ?? "novel"),
        raw_id: target.rawId,
        slug: target.slug,
        title: tidy(serie.data?.title),
        author: tidy(serie.data?.author) || null,
        status: statusLabel(serie.status),
        rating: serie.rating ?? null,
        views: serie.view ?? null,
        synopsis: tidy(serie.data?.description),
        cover: serie.data?.image ?? null,
        genres,
        tags,
        ranks,
        total_chapters: serie.chapter_count ?? chapters.length,
        available_chapters: chapters.length,
        first_chapter: first,
        latest_chapter: last,
        chapters,
      };
    },
  },
  {
    category: "novel",
    slug: "chapter",
    kind: "json",
    title: "Baca Chapter Novel",
    description: "Isi teks satu chapter novel (paragraf bahasa Inggris hasil terjemahan AI WTR-LAB) beserta navigasi chapter sebelum dan sesudahnya.",
    params: [
      { name: "slug", required: true, description: "raw_id, slug, atau URL novel/chapter WTR-LAB.", example: "106254" },
      { name: "chapter", description: "Nomor chapter. Bila kosong, dipakai dari URL atau chapter 1.", example: "1" },
    ],
    handler: async ({ sp }) => {
      const raw = need(sp, "slug", 400);
      const { rawId, slug, chapter } = await resolveTarget(raw);
      const order = opt(sp, "chapter") ? Math.floor(num(sp, "chapter", 1, 1, 20000)) : chapter ?? 1;
      if (!slug) {
        const { target } = await loadSerie(String(rawId)).catch(() => ({ target: { slug: null } as { slug: string | null } }));
        if (!target.slug) throw new HttpError(404, "Slug novel tidak ditemukan; kirim slug atau URL novel.");
        return chapterContent(rawId, target.slug, order);
      }
      return chapterContent(rawId, slug, order);
    },
  },
  {
    category: "novel",
    slug: "image",
    kind: "image",
    title: "Proxy Gambar Novel",
    description: "Tampilkan sampul novel dari server WTR-LAB lewat proxy (mengatasi blokir hotlink). Hanya menerima host wtr-lab.",
    params: [{ name: "url", required: true, description: "URL sampul dari endpoint lain di kategori ini.", example: "https://img.wtr-lab.com/cdn/series/WinGjuQqScLdg9MrEZewIkXOnRuQaqNbGoVpFy4JPiQ.jpg" }],
    handler: async ({ sp }) => {
      const raw = need(sp, "url", 1000);
      let parsed: URL | null = null;
      try {
        parsed = new URL(raw);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.protocol !== "https:" || !COVER_HOSTS.test(parsed.hostname)) {
        throw new HttpError(400, "Hanya URL gambar https dari host wtr-lab yang diizinkan.");
      }
      const res = await fetch(parsed.toString(), {
        headers: browserHeaders(REFERER, { accept: "image/avif,image/webp,image/*,*/*;q=0.8" }),
        cache: "no-store",
      }).catch(() => null);
      if (!res) throw new HttpError(502, "Gagal menghubungi server gambar WTR-LAB.");
      if (!res.ok) throw new HttpError(502, `Server gambar WTR-LAB merespons dengan status ${res.status}.`);
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!type.startsWith("image/")) throw new HttpError(502, "Server sumber tidak mengirim gambar.");
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 4_300_000) throw new HttpError(413, "Gambar terlalu besar untuk diproxy (maks ±4 MB). Gunakan URL aslinya.");
      return new Response(buf as BodyInit, { headers: { "content-type": type, "cache-control": "public, max-age=86400, s-maxage=604800, immutable" } });
    },
  },
];
