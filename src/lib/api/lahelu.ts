import { HttpError } from "./types";
import { browserHeaders, clean } from "./scrape";

/*
 * Meme acak dari lahelu.com.
 *
 * Situsnya memuat daftar meme dari API internalnya sendiri (6 meme per halaman):
 *   - /api/post/get-recommendations?field=7&cursor=<halaman>  : meme populer, sekitar 3.000+ halaman
 *   - /api/post/get-posts?feed=2&page=<halaman>&hashtag=<tag> : meme per tagar
 * Lahelu berada di balik Cloudflare dan mulai menjawab 429 setelah belasan permintaan
 * beruntun. Karena itu meme yang sudah terambil disimpan di "kolam" per tagar, halaman baru
 * hanya diambil berkala, dan permintaan yang datang bersamaan berbagi satu pengambilan.
 */

const SITE = "https://lahelu.com";
const API = `${SITE}/api/post`;
const CDN = "https://cache.lahelu.com/";
const UA = browserHeaders(`${SITE}/`)["user-agent"];

/** Jeda minimal antar pengambilan halaman baru untuk satu kolam. */
const PAGE_GAP_MS = 3000;
/** Batas panggilan ke Lahelu per menit untuk satu instance server. */
const MAX_CALLS_PER_MIN = 30;
const POOL_ITEMS = 240;
const POOL_KEYS = 40;
/** Tagar yang ternyata kosong diingat sebentar supaya tidak ditanyakan terus. */
const EMPTY_TTL_MS = 10 * 60 * 1000;
/**
 * Jangkauan halaman yang diacak. Meme populer punya 3.000 halaman lebih (diukur langsung).
 * Jumlah halaman sebuah tagar tidak diketahui, jadi jangkauannya mulai dari satu halaman,
 * berlipat dua setiap kali halaman di separuh atasnya ternyata berisi, dan berhenti tumbuh
 * begitu menemukan halaman kosong.
 */
const PAGES_ALL = 3000;
const PAGES_TAG_MAX = 200;

export type MemeKind = "image" | "video";
export type MemeFilter = MemeKind | "any";

export type LaheluMeme = {
  id: string;
  title: string;
  type: MemeKind;
  /** Berkas utama: gambar (biasanya WebP) atau video MP4. */
  media: string;
  /** Gambar pratinjau untuk video. */
  thumbnail: string | null;
  width: number | null;
  height: number | null;
  upvotes: number;
  downvotes: number;
  comments: number;
  hashtags: string[];
  topic: string | null;
  author: string | null;
  created_at: string | null;
  source: string;
};

type RawPost = {
  postId?: string; postID?: string; title?: string; type?: number; isSensitive?: boolean;
  totalUpvotes?: number; totalDownvotes?: number; totalComments?: number; createTime?: number;
  hashtags?: string[]; media?: string; mediaType?: number; mediaThumbnail?: string;
  mediaWidth?: number; mediaHeight?: number; userUsername?: string; topicTitle?: string;
  content?: { type?: number; value?: string }[];
};

type Pool = {
  items: LaheluMeme[];
  ids: Set<string>;
  pages: number;
  /** Halaman yang sudah pernah diambil, supaya pengambilan berikutnya memilih halaman lain dulu. */
  seen: Set<number>;
  /** Ujung daftar sudah ketemu (atau sudah ditetapkan), jadi `pages` tidak ditumbuhkan lagi. */
  capped: boolean;
  fetchedAt: number;
  /** Sudah pernah menerima halaman berisi, jadi sumbernya (tagar) memang ada. */
  known: boolean;
  emptyAt: number;
  running: Promise<number> | null;
  last: string | null;
};

const pools = new Map<string, Pool>();
const calls: number[] = [];

const abs = (u?: string): string | null => (u ? (/^https?:\/\//.test(u) ? u : CDN + u.replace(/^\/+/, "")) : null);

function normalize(p: RawPost): LaheluMeme | null {
  const id = p.postId ?? p.postID;
  if (!id || p.isSensitive) return null;
  // Jenis media: 0/3 gambar, 1/4 video (3 dan 4 adalah versi ber-watermark pada kiriman baru).
  const main = p.content?.find((c) => c.value && (c.type === 0 || c.type === 1 || c.type === 3 || c.type === 4));
  const media = abs(p.media ?? main?.value);
  if (!media) return null;
  const code = p.mediaType ?? main?.type;
  let type: MemeKind | null = code === 0 || code === 3 ? "image" : code === 1 || code === 4 ? "video" : null;
  if (!type) type = p.type === 0 ? "image" : p.type === 1 ? "video" : null;
  if (!type) return null;
  return {
    id,
    title: clean(p.title),
    type,
    media,
    thumbnail: type === "video" ? abs(p.mediaThumbnail ?? p.content?.find((c) => c.type === 2)?.value) : null,
    width: p.mediaWidth ?? null,
    height: p.mediaHeight ?? null,
    upvotes: p.totalUpvotes ?? 0,
    downvotes: p.totalDownvotes ?? 0,
    comments: p.totalComments ?? 0,
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.filter((h) => typeof h === "string") : [],
    topic: p.topicTitle || null,
    author: p.userUsername ?? null,
    created_at: p.createTime ? new Date(p.createTime).toISOString() : null,
    source: `${SITE}/post/${id}`,
  };
}

/** Satu halaman meme. `total` 0 berarti halaman itu berada di luar jangkauan. */
async function fetchPage(tag: string, page: number): Promise<{ memes: LaheluMeme[]; total: number }> {
  const now = Date.now();
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  if (calls.length >= MAX_CALLS_PER_MIN) throw new HttpError(429, "Permintaan ke Lahelu sedang padat. Coba lagi sekitar satu menit lagi.");
  calls.push(now);

  const url = tag
    ? `${API}/get-posts?feed=2&page=${page}&hashtag=${encodeURIComponent(tag)}`
    : `${API}/get-recommendations?field=7&cursor=${page}`;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      headers: { "user-agent": UA, accept: "application/json, text/plain, */*", "accept-language": "id-ID,id;q=0.9,en;q=0.8", referer: `${SITE}/` },
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new HttpError(504, "Lahelu terlalu lama merespons.");
    throw new HttpError(502, "Gagal menghubungi Lahelu.");
  }
  const text = await res.text();
  if (res.status === 429 || res.status === 403 || res.status === 503) throw new HttpError(429, "Lahelu sedang membatasi permintaan. Coba lagi beberapa saat lagi.");
  if (!res.ok) throw new HttpError(502, `Lahelu merespons dengan status ${res.status}.`);
  let data: { postInfos?: RawPost[] };
  try {
    data = JSON.parse(text) as { postInfos?: RawPost[] };
  } catch {
    throw new HttpError(502, "Lahelu mengirim respons yang tidak bisa dibaca.");
  }
  if (!Array.isArray(data.postInfos)) throw new HttpError(502, "Lahelu mengirim respons dengan bentuk yang tidak dikenal.");
  // `total` dihitung sebelum disaring: halaman yang isinya sensitif semua tetap halaman yang ada.
  return { memes: data.postInfos.map(normalize).filter((m): m is LaheluMeme => !!m), total: data.postInfos.length };
}

function poolFor(tag: string): Pool {
  let pool = pools.get(tag);
  if (!pool) {
    if (pools.size >= POOL_KEYS) {
      // Kolam meme populer (kunci kosong) dipertahankan; yang dibuang kolam tagar tertua.
      for (const k of pools.keys()) if (k) { pools.delete(k); break; }
    }
    pool = { items: [], ids: new Set(), pages: tag ? 1 : PAGES_ALL, seen: new Set(), capped: !tag, fetchedAt: 0, known: false, emptyAt: 0, running: null, last: null };
    pools.set(tag, pool);
  }
  return pool;
}

/** Halaman acak dalam jangkauan, mendahulukan yang belum pernah diambil. */
function nextPage(pool: Pool): number {
  if (pool.pages <= 12) {
    const unseen: number[] = [];
    for (let i = 0; i < pool.pages; i++) if (!pool.seen.has(i)) unseen.push(i);
    if (unseen.length) return unseen[Math.floor(Math.random() * unseen.length)];
  } else {
    for (let i = 0; i < 6; i++) {
      const page = Math.floor(Math.random() * pool.pages);
      if (!pool.seen.has(page)) return page;
    }
  }
  return Math.floor(Math.random() * pool.pages);
}

/** Mengambil satu halaman acak ke dalam kolam. Mengembalikan banyaknya meme baru. */
async function refill(tag: string, pool: Pool): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = attempt === 2 ? 0 : nextPage(pool);
    const { memes, total } = await fetchPage(tag, page);
    pool.seen.add(page);
    if (pool.seen.size > 2000) pool.seen.clear();
    if (!total) {
      if (page === 0) {
        if (!pool.known) pool.emptyAt = Date.now();
        return 0;
      }
      pool.pages = page;
      pool.capped = true;
      continue;
    }
    pool.known = true;
    pool.emptyAt = 0;
    if (!pool.capped) pool.pages = Math.min(PAGES_TAG_MAX, Math.max(pool.pages, (page + 1) * 2));
    let added = 0;
    for (const m of memes) {
      if (pool.ids.has(m.id)) continue;
      pool.ids.add(m.id);
      pool.items.push(m);
      added++;
    }
    while (pool.items.length > POOL_ITEMS) pool.ids.delete(pool.items.shift()!.id);
    return added;
  }
  return 0;
}

function refillOnce(tag: string, pool: Pool): Promise<number> {
  if (!pool.running) {
    pool.fetchedAt = Date.now();
    pool.running = refill(tag, pool).finally(() => {
      pool.running = null;
    });
  }
  return pool.running;
}

/** Tagar seperti yang dipakai Lahelu: huruf kecil, angka, dan tanda hubung. */
export function laheluTag(raw: string): string {
  return raw.toLowerCase().replace(/^#+/, "").trim().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

export async function randomLaheluMeme(filter: MemeFilter, tag: string): Promise<LaheluMeme> {
  const pool = poolFor(tag);
  const pick = () => pool.items.filter((m) => filter === "any" || m.type === filter);
  const knownEmpty = () => pool.emptyAt > 0 && Date.now() - pool.emptyAt < EMPTY_TTL_MS;

  let found = pick();
  if (!knownEmpty() && (!found.length || Date.now() - pool.fetchedAt >= PAGE_GAP_MS)) {
    let added = 0;
    try {
      added = await refillOnce(tag, pool);
    } catch (e) {
      // Lahelu sedang menolak atau lambat: selama kolam masih berisi, pakai yang ada.
      if (!found.length) throw e;
    }
    found = pick();
    // Halaman yang baru datang bisa saja tidak memuat jenis yang diminta (mis. tidak ada gambar),
    // jadi ambil beberapa halaman lagi selama masih ada meme baru yang masuk.
    for (let i = 0; i < 3 && !found.length && added > 0 && !knownEmpty(); i++) {
      added = await refillOnce(tag, pool);
      found = pick();
    }
  }
  if (!found.length) {
    if (tag && !pool.known) throw new HttpError(404, `Tagar '${tag}' tidak ditemukan di Lahelu atau belum punya meme.`);
    throw new HttpError(404, "Belum menemukan meme dengan jenis itu. Coba lagi.");
  }
  // Hindari mengirim meme yang sama dua kali berturut-turut.
  const fresh = found.length > 1 ? found.filter((m) => m.id !== pool.last) : found;
  const meme = fresh[Math.floor(Math.random() * fresh.length)];
  pool.last = meme.id;
  return meme;
}
