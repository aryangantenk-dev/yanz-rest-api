import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { need, num, opt } from "./helpers";
import { escapeHtml } from "./scrape";

/*
 * Sumber: https://animekuy.web.id/film (situs milik sendiri, di Netlify).
 * Halamannya SPA; datanya diambil dari Netlify Function situs itu
 * (/.netlify/functions/film?action=...), yang meneruskan metadata TMDB.
 * Videonya tidak di-host di sana: situs memasang iframe ke penyedia embed pihak
 * ketiga dengan pola URL tetap (ID TMDB, atau ID IMDb untuk VidSrc). Pola yang sama
 * dipakai di sini, jadi tidak ada halaman penyedia yang di-scrape.
 */
const SITE = "https://animekuy.web.id";
const API = `${SITE}/.netlify/functions/film`;

type J = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s && s !== "N/A" ? s : null;
};
const intv = (v: unknown): number | null => {
  const s = str(v);
  return s && /^\d{1,9}$/.test(s) ? Number(s) : null;
};

/* ------------------------------------------------------------ pengambilan */

const MIN = 60_000;
/** Tiap panggilan keluar memakai jatah Netlify Functions situs sumber, jadi dibatasi dan disimpan. */
const MAX_PER_MINUTE = 60;
const cache = new Map<string, { at: number; ttl: number; data: J }>();
const inflight = new Map<string, Promise<J>>();
const calls: number[] = [];

async function kuyGet(params: Record<string, string | number>, ttl: number): Promise<J> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const key = qs.toString();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.data;
  const running = inflight.get(key);
  if (running) return running;

  while (calls.length && now - calls[0] > MIN) calls.shift();
  if (calls.length >= MAX_PER_MINUTE) throw new HttpError(429, "Permintaan ke Animekuy sedang padat. Coba lagi sekitar satu menit lagi.");
  calls.push(now);

  const job = (async () => {
    let res: Response;
    try {
      res = await fetch(`${API}?${key}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(16000),
        headers: { accept: "application/json", "user-agent": "YanzAPI/1.0", referer: `${SITE}/film` },
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new HttpError(504, "Animekuy terlalu lama merespons.");
      throw new HttpError(502, "Gagal menghubungi Animekuy.");
    }
    const text = await res.text();
    let body: J | null = null;
    try {
      body = obj(JSON.parse(text));
    } catch {
      body = null;
    }
    const msg = str(body?.error);
    if (!res.ok) {
      if (msg && /tidak ditemukan/i.test(msg)) throw new HttpError(404, msg);
      if (res.status === 400) throw new HttpError(400, msg ?? "Permintaan ditolak Animekuy.");
      if (res.status === 429) throw new HttpError(429, "Animekuy sedang membatasi permintaan. Coba lagi beberapa saat lagi.");
      throw new HttpError(502, msg ? `Animekuy: ${msg}` : `Animekuy merespons dengan status ${res.status}.`);
    }
    if (!body) throw new HttpError(502, "Animekuy tidak mengembalikan JSON.");
    if (cache.size >= 500) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), ttl, data: body });
    return body;
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/* ------------------------------------------------------------ bentuk data */

type Kind = "movie" | "series";

/** Kartu di daftar. Kolom `imdbID` dari sumber sebenarnya berisi ID TMDB. */
function listItems(body: J) {
  if (body.Response === "False") return [];
  if (!Array.isArray(body.Search)) throw new HttpError(502, "Format daftar dari Animekuy berubah.");
  const seen = new Set<string>();
  const out: { id: string; title: string; type: Kind; year: number | null; poster: string | null }[] = [];
  for (const raw of body.Search) {
    const x = obj(raw);
    const id = (str(x.imdbID) ?? "").toLowerCase();
    const type = x.Type === "series" ? "series" : x.Type === "movie" ? "movie" : null;
    if (!type || !/^(?:tt\d{5,12}|\d{1,12})$/.test(id) || seen.has(`${type}:${id}`)) continue;
    seen.add(`${type}:${id}`);
    out.push({ id, title: str(x.Title) ?? `Film ${id}`, type, year: intv(x.Year), poster: httpsUrl(x.Poster) });
  }
  return out;
}

function httpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

function idParam(sp: URLSearchParams): string {
  const id = need(sp, "id", 20).toLowerCase();
  if (!/^(?:tt\d{5,12}|\d{1,12})$/.test(id)) throw new HttpError(400, "Parameter 'id' harus ID TMDB (angka, mis. 19995) atau ID IMDb (mis. tt0499549).");
  return id;
}

function kindParam(sp: URLSearchParams): Kind | null {
  const t = opt(sp, "tipe").toLowerCase();
  if (!t) return null;
  if (t === "movie" || t === "film") return "movie";
  if (t === "series" || t === "serial" || t === "tv") return "series";
  throw new HttpError(400, "Parameter 'tipe' tidak dikenal. Pilihan: movie, series.");
}

type Detail = {
  id: string;
  imdb_id: string | null;
  title: string;
  type: Kind;
  year: number | null;
  runtime: string | null;
  genres: string[];
  rating: number | null;
  plot: string | null;
  poster: string | null;
  total_seasons: number | null;
};

/**
 * ID TMDB film dan serial saling tumpang tindih (19995 = film Avatar, tetapi juga bisa
 * serial lain), jadi untuk ID angka `tipe` wajib. ID IMDb sudah unik.
 */
async function loadDetail(id: string, kind: Kind | null): Promise<Detail> {
  const isImdb = id.startsWith("tt");
  if (!isImdb && !kind) throw new HttpError(400, "Parameter 'tipe' wajib diisi untuk ID TMDB: movie atau series. ID IMDb (tt...) tidak membutuhkannya.");
  const d = await kuyGet({ action: "detail", id, ...(kind ? { type: kind } : {}) }, 6 * 60 * MIN);
  const type = d.Type === "series" ? "series" : d.Type === "movie" ? "movie" : null;
  const tmdb = str(d.tmdbId);
  if (d.Response === "False" || !type || !tmdb) throw new HttpError(404, "Judul tidak ditemukan di TMDB.");
  const imdb = (str(d.imdbID) ?? "").toLowerCase();
  const rating = Number(str(d.imdbRating));
  const seasons = intv(d.totalSeasons);
  return {
    id: tmdb,
    imdb_id: /^tt\d{5,12}$/.test(imdb) ? imdb : null,
    title: str(d.Title) ?? `Film ${tmdb}`,
    type,
    year: intv(d.Year),
    runtime: str(d.Runtime),
    genres: (str(d.Genre) ?? "").split(",").map((g) => g.trim()).filter(Boolean),
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    plot: str(d.Plot),
    poster: httpsUrl(d.Poster),
    total_seasons: type === "series" ? seasons ?? 0 : null,
  };
}

async function loadSeason(tmdbId: string, season: number) {
  const body = await kuyGet({ action: "season", id: tmdbId, type: "series", season }, 60 * MIN);
  const out: { episode: number; title: string | null }[] = [];
  for (const raw of arr(body.Episodes)) {
    const e = obj(raw);
    const n = intv(e.Episode);
    if (n && n <= 10000) out.push({ episode: n, title: str(e.Title) });
  }
  return out;
}

/* ------------------------------------------------------------ player */

const SERVERS = ["vidy", "embedmaster", "vidsrc", "vidlink"] as const;
type Server = (typeof SERVERS)[number];
const SERVER_NAME: Record<Server, string> = { vidy: "Vidy", embedmaster: "EmbedMaster", vidsrc: "VidSrc", vidlink: "VidLink" };

/** Pola URL yang sama dengan film.js di Animekuy. VidSrc memakai ID IMDb, sisanya ID TMDB. */
function playerUrl(server: Server, d: Detail, season: number, episode: number): string | null {
  const series = d.type === "series";
  const path = series ? `tv/${d.id}/${season}/${episode}` : `movie/${d.id}`;
  if (server === "vidy") return `https://www.vidy.st/${path}`;
  if (server === "embedmaster") return `https://embedmaster.link/${path}`;
  if (server === "vidlink") return `https://vidlink.pro/${path}`;
  if (!d.imdb_id) return null;
  return `https://vidsrc.to/embed/${series ? `tv/${d.imdb_id}/${season}/${episode}` : `movie/${d.imdb_id}`}`;
}

function playerList(d: Detail, season: number, episode: number) {
  return SERVERS.map((server) => ({ server, name: SERVER_NAME[server], url: playerUrl(server, d, season, episode) })).filter(
    (p): p is { server: Server; name: string; url: string } => p.url !== null,
  );
}

/** Membaca id/tipe/season/episode, memastikan judulnya ada dan (untuk serial) episodenya terdaftar di TMDB. */
async function resolvePlay(sp: URLSearchParams) {
  const d = await loadDetail(idParam(sp), kindParam(sp));
  if (d.type === "movie") return { d, season: 0, episode: 0, episode_title: null as string | null };
  const season = Math.floor(num(sp, "season", 1, 1, 100));
  const episode = Math.floor(num(sp, "episode", 1, 1, 10000));
  if (d.total_seasons && season > d.total_seasons) throw new HttpError(404, `Season ${season} tidak ada. '${d.title}' punya ${d.total_seasons} season.`);
  const list = await loadSeason(d.id, season);
  const found = list.find((e) => e.episode === episode);
  if (!found) throw new HttpError(404, list.length ? `Episode ${episode} tidak ada. Season ${season} punya ${list.length} episode.` : `Season ${season} belum punya daftar episode di TMDB.`);
  return { d, season, episode, episode_title: found.title };
}

function embedHtml(title: string, url: string): string {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style>
</head>
<body>
<iframe src="${escapeHtml(url)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="no-referrer"></iframe>
</body>
</html>`;
}

/* ------------------------------------------------------------ endpoint */

const ID_PARAM = { name: "id", required: true, description: "ID TMDB (angka dari daftar/pencarian) atau ID IMDb (tt...).", example: "19995" };
const TIPE_PARAM = { name: "tipe", description: "movie atau series. Wajib untuk ID TMDB karena ID film dan serial bisa sama; tidak perlu untuk ID IMDb.", example: "movie", options: ["movie", "series"] };

function discover(slug: string, section: string, title: string, description: string): Endpoint {
  return {
    category: "film", slug, kind: "json", title, description,
    params: [],
    handler: async () => {
      const items = listItems(await kuyGet({ action: "discover", section }, 10 * MIN));
      if (!items.length) throw new HttpError(502, "Animekuy tidak mengirim judul apa pun untuk bagian ini.");
      return { source: SITE, total: items.length, items };
    },
  };
}

export const filmEndpoints: Endpoint[] = [
  discover("trending", "trending", "Film Trending", "Film yang sedang ramai minggu ini (data TMDB lewat Animekuy). ID tiap judul dipakai di endpoint detail dan player."),
  discover("populer", "popular", "Film Populer", "Daftar film populer saat ini (data TMDB lewat Animekuy)."),
  discover("series", "series", "Serial Populer", "Daftar serial TV populer (data TMDB lewat Animekuy). Pakai tipe=series saat membuka detailnya."),
  {
    category: "film", slug: "search", kind: "json",
    title: "Cari Film & Serial",
    description: "Cari film dan serial berdasarkan judul. Tiap hasil membawa id dan type untuk endpoint detail, season, dan player.",
    params: [
      { name: "q", required: true, description: "Judul film atau serial, minimal 2 karakter.", example: "avatar" },
      { name: "page", description: "Nomor halaman hasil (1-500).", example: "1" },
    ],
    handler: async ({ sp }) => {
      const q = need(sp, "q", 100);
      if (q.length < 2) throw new HttpError(400, "Parameter 'q' minimal 2 karakter.");
      const page = Math.floor(num(sp, "page", 1, 1, 500));
      const body = await kuyGet({ action: "search", q, page }, 10 * MIN);
      const items = listItems(body);
      return { source: SITE, query: q, page, total_pages: intv(body.totalPages) ?? 1, total_results: intv(body.totalResults) ?? items.length, total: items.length, items };
    },
  },
  {
    category: "film", slug: "detail", kind: "json",
    title: "Detail Film / Serial",
    description: "Metadata satu judul: sinopsis, genre, rating, durasi, poster, ID IMDb. Film langsung disertai link player; serial disertai jumlah season (daftar episodenya ada di endpoint season).",
    params: [ID_PARAM, TIPE_PARAM],
    handler: async ({ sp, origin }) => {
      const d = await loadDetail(idParam(sp), kindParam(sp));
      if (d.type === "series") return { source: SITE, ...d };
      return { source: SITE, ...d, embed: `${origin}/api/film/embed?id=${d.id}&tipe=movie`, players: playerList(d, 0, 0) };
    },
  },
  {
    category: "film", slug: "season", kind: "json",
    title: "Daftar Episode Serial",
    description: "Daftar episode satu season dari sebuah serial. Nomor season dan episodenya dipakai di endpoint player dan embed.",
    params: [
      { name: "id", required: true, description: "ID TMDB serial (angka) atau ID IMDb (tt...).", example: "82452" },
      { name: "season", description: "Nomor season, mulai dari 1. Default 1.", example: "1" },
    ],
    handler: async ({ sp }) => {
      const id = idParam(sp);
      const d = await loadDetail(id, id.startsWith("tt") ? null : "series");
      if (d.type !== "series") throw new HttpError(400, `'${d.title}' adalah film, bukan serial. Pakai endpoint detail.`);
      const season = Math.floor(num(sp, "season", 1, 1, 100));
      if (d.total_seasons && season > d.total_seasons) throw new HttpError(404, `Season ${season} tidak ada. '${d.title}' punya ${d.total_seasons} season.`);
      const episodes = await loadSeason(d.id, season);
      return { source: SITE, id: d.id, imdb_id: d.imdb_id, title: d.title, season, total_seasons: d.total_seasons, total: episodes.length, episodes };
    },
  },
  {
    category: "film", slug: "rekomendasi", kind: "json",
    title: "Rekomendasi Serupa",
    description: "Film atau serial yang mirip dengan satu judul, untuk bagian \"judul serupa\".",
    params: [ID_PARAM, TIPE_PARAM],
    handler: async ({ sp }) => {
      const d = await loadDetail(idParam(sp), kindParam(sp));
      const items = listItems(await kuyGet({ action: "recommendations", id: d.id, type: d.type }, 6 * 60 * MIN));
      return { source: SITE, id: d.id, title: d.title, type: d.type, total: items.length, items };
    },
  },
  {
    category: "film", slug: "player", kind: "json",
    title: "Link Player",
    description: "URL embed dari empat penyedia (Vidy, EmbedMaster, VidSrc, VidLink) untuk satu film atau satu episode serial. Pasang salah satunya sebagai src <iframe>. Ketersediaan video, subtitle, dan iklan mengikuti penyedia masing-masing.",
    params: [
      ID_PARAM,
      TIPE_PARAM,
      { name: "season", description: "Nomor season, khusus serial. Default 1.", example: "" },
      { name: "episode", description: "Nomor episode, khusus serial. Default 1.", example: "" },
    ],
    handler: async ({ sp, origin }) => {
      const { d, season, episode, episode_title } = await resolvePlay(sp);
      const series = d.type === "series";
      const tail = series ? `&season=${season}&episode=${episode}` : "";
      return {
        source: SITE,
        id: d.id,
        imdb_id: d.imdb_id,
        title: d.title,
        type: d.type,
        ...(series ? { season, episode, episode_title } : {}),
        poster: d.poster,
        embed: `${origin}/api/film/embed?id=${d.id}&tipe=${d.type}${tail}`,
        players: playerList(d, season, episode),
      };
    },
  },
  {
    category: "film", slug: "embed", kind: "html",
    title: "Embed Player",
    description: "Halaman HTML berisi player film atau episode, layar penuh. Pakai URL ini langsung sebagai src <iframe> di situsmu. Videonya dimuat dari penyedia pihak ketiga yang bisa menampilkan iklan.",
    params: [
      ID_PARAM,
      TIPE_PARAM,
      { name: "season", description: "Nomor season, khusus serial. Default 1.", example: "" },
      { name: "episode", description: "Nomor episode, khusus serial. Default 1.", example: "" },
      { name: "server", description: "Penyedia player. Default vidy.", example: "vidy", options: [...SERVERS] },
    ],
    handler: async ({ sp }) => {
      const server = (opt(sp, "server", "vidy").toLowerCase() as Server);
      if (!SERVERS.includes(server)) throw new HttpError(400, `Parameter 'server' tidak dikenal. Pilihan: ${SERVERS.join(", ")}.`);
      const { d, season, episode } = await resolvePlay(sp);
      const url = playerUrl(server, d, season, episode);
      if (!url) throw new HttpError(404, "Judul ini tidak punya ID IMDb, jadi VidSrc tidak bisa dipakai. Coba server lain.");
      const title = d.type === "series" ? `${d.title} S${season}E${episode}` : d.title;
      return new Response(embedHtml(title, url), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300, s-maxage=600",
          "content-security-policy": "default-src 'none'; frame-src https:; style-src 'unsafe-inline'; frame-ancestors *",
          "x-robots-tag": "noindex",
        },
      });
    },
  },
];
