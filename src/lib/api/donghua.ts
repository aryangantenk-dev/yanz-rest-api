import { load, type CheerioAPI } from "cheerio";
import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { binaryResponse, fetchJson, fetchRaw, need, num, opt } from "./helpers";
import { absUrl, browserHeaders, clean, cleanSlug, escapeHtml, fetchPage, imgSrc, pathParts, type El, type Page } from "./scrape";

/*
  Sumber: https://anichin.ro (WordPress, tema AniStream — sama seperti anime-kuindo).
  Bedanya dengan modul anime: seri beralamat /anime/<slug>, pencarian di /search?q=,
  dan daftar episode di beranda memakai markup <div class="bs"> tanpa <article>.
*/
const BASE = "https://anichin.ro";
const REFERER = `${BASE}/`;
const IMAGE_HOSTS = /(^|\.)anichin\.(ro|moe|com|id|net|xyz)$/i;

const seriesUrl = (slug: string) => `${BASE}/anime/${encodeURIComponent(slug)}`;
const episodeUrl = (slug: string) => `${BASE}/${encodeURIComponent(slug)}`;
// Anichin memakai ?s= untuk pencarian (bukan ?q=).
const searchUrl = (q: string, page: number) => `${BASE}/search?s=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ""}`;

/** Path yang bukan seri maupun episode, supaya link seperti /genres/action tidak salah tebak. */
const RESERVED = new Set([
  "anime", "genres", "genre", "season", "seasonx", "studio", "studios", "network", "country", "cast", "page", "category",
  "tag", "author", "wp-json", "wp-admin", "wp-content", "wp-login.php", "search", "schedule", "bookmark", "az-list",
  "list-mode", "movies", "movie", "tv", "ova", "ona", "special", "music", "home", "advanced-search", "feed", "sitemap.xml",
]);

type LinkRef = { kind: "series" | "episode"; slug: string; url: string };

function classify(href: string | undefined | null): LinkRef | null {
  if (!href) return null;
  try {
    if (new URL(href, BASE).hostname !== new URL(BASE).hostname) return null;
  } catch {
    return null;
  }
  const p = pathParts(href, BASE);
  if (!p.length) return null;
  if (p[0] === "anime" && p[1]) return { kind: "series", slug: p[1], url: seriesUrl(p[1]) };
  if (p.length === 1 && !RESERVED.has(p[0])) return { kind: "episode", slug: p[0], url: episodeUrl(p[0]) };
  return null;
}

/** Terima slug polos atau URL anichin lengkap. */
function slugParam(raw: string): { slug: string; hint: "series" | "episode" | null } {
  if (/^https?:\/\//i.test(raw)) {
    const ref = classify(raw);
    if (!ref) throw new HttpError(400, "URL anichin tidak dikenali.");
    return { slug: cleanSlug(ref.slug), hint: ref.kind };
  }
  const isSeries = /^\/?anime\//i.test(raw);
  return { slug: cleanSlug(raw.replace(/^\/?anime\//i, "")), hint: isSeries ? "series" : null };
}

function hasNextPage($: CheerioAPI, page: number): boolean {
  return (
    $(`.hpage a[href*="page=${page + 1}"], .pagination a[href*="page=${page + 1}"], .hpage a[href*="/page/${page + 1}/"]`).length > 0 ||
    $("a.next.page-numbers").length > 0
  );
}

type Card = {
  title: string;
  kind: "series" | "episode";
  slug: string;
  url: string;
  poster: string | null;
  status: string | null;
  type: string | null;
  episode: string | null;
  sub: string | null;
  episode_title: string | null;
  latest_episode: { title: string; slug: string; url: string } | null;
};

/**
 * Kartu seri/episode: <div class="bs"><div class="bsx">…</div></div>.
 * Di dalam .tt, <h2> berisi judul episode (atau judul seri bila kartunya kartu seri),
 * sedangkan teks di luar <h2> adalah nama serinya.
 */
function card($: CheerioAPI, el: El): Card | null {
  const tt = el.find(".tt").first();
  const h2 = clean(tt.find("h2").first().text());
  const ttRest = (() => {
    const clone = tt.clone();
    clone.find("h2").remove();
    return clean(clone.text());
  })();

  // Kartu seri: tautan utama menuju /anime/<slug>.
  const seriesLink = el.find('a[href*="/anime/"]').first();
  const seriesRef = classify(seriesLink.attr("href"));
  if (seriesRef?.kind === "series") {
    const latestRef = classify(el.find('.tt a[href]:not([href*="/anime/"])').last().attr("href"));
    // Di daftar seri, nama seri ada di teks .tt dan <h2> berisi judul episode terbarunya.
    return {
      title: ttRest || h2 || clean(seriesLink.attr("title")) || seriesRef.slug,
      kind: "series",
      slug: seriesRef.slug,
      url: seriesRef.url,
      poster: imgSrc(el.find("img").first(), BASE),
      status: clean(el.find(".status").first().text()) || null,
      type: clean(el.find(".typez").first().text()) || null,
      episode: clean(el.find(".epx").first().text()) || null,
      sub: clean(el.find(".sb").first().text()) || null,
      episode_title: h2 && h2 !== ttRest ? h2 : null,
      latest_episode: latestRef?.kind === "episode" ? { title: h2 || latestRef.slug, slug: latestRef.slug, url: latestRef.url } : null,
    };
  }

  // Kartu episode: tautan utama menuju /<slug-episode>.
  const epRef = classify(el.find("a[href]").first().attr("href"));
  if (!epRef || epRef.kind !== "episode") return null;
  const title = ttRest || clean(el.find("a").first().attr("title")) || h2 || epRef.slug;
  return {
    title,
    kind: "episode",
    slug: epRef.slug,
    url: epRef.url,
    poster: imgSrc(el.find("img").first(), BASE),
    status: clean(el.find(".status").first().text()) || null,
    type: clean(el.find(".typez").first().text()) || null,
    episode: clean(el.find(".epx").first().text()) || null,
    sub: clean(el.find(".sb").first().text()) || null,
    episode_title: h2 || null,
    latest_episode: { title: h2 || title, slug: epRef.slug, url: epRef.url },
  };
}

/** Semua kartu pada satu halaman daftar. */
function cards($: CheerioAPI): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  $(".listupd .bs, .listupd article, article.bs, .bs").each((_, node) => {
    const c = card($, $(node));
    if (!c || seen.has(`${c.kind}:${c.slug}`)) return;
    seen.add(`${c.kind}:${c.slug}`);
    out.push(c);
  });
  return out;
}

/** Bagian beranda: judul (.releases) lalu kartu-kartunya. */
function sections($: CheerioAPI): { name: string; items: Card[] }[] {
  const out: { name: string; items: Card[] }[] = [];
  let current: { name: string; items: Card[] } | null = null;
  $(".releases, .listupd .bs").each((_, node) => {
    const el = $(node);
    if (el.hasClass("releases")) {
      current = { name: clean(el.find("h1, h2, h3").first().text()), items: [] };
      out.push(current);
      return;
    }
    const c = card($, el);
    if (!c) return;
    if (!current) {
      current = { name: "", items: [] };
      out.push(current);
    }
    current.items.push(c);
  });
  return out.filter((s) => s.items.length);
}

type EpisodeRef = { episode: string | null; title: string; slug: string; url: string; date: string | null };
type Server = { index: number; name: string; url: string; iframe: string };

function iframeTag(url: string): string {
  return `<iframe src="${escapeHtml(url)}" width="100%" style="aspect-ratio:16/9;border:0" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
}

function httpsUrl(raw: string | undefined | null): string | null {
  const u = absUrl(raw, BASE);
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** ID episode internal Anichin (dipakai API /api/theme), diambil dari #as-servers[data-episode]. */
function episodeId($: CheerioAPI): string | null {
  const id = clean($("#as-servers").attr("data-episode"));
  if (/^\d+$/.test(id)) return id;
  const m = $("body").text().match(/"episode_?id"\s*:\s*"?([0-9]+)/i);
  return m?.[1] ?? null;
}

type ThemeServers = { status?: boolean; html?: string; downloads?: string };

const THEME_HEADERS = { accept: "application/json, text/javascript, */*; q=0.01", "x-requested-with": "XMLHttpRequest" };

/**
 * Server player & link unduhan dimuat lewat API JSON internal situs
 * (/api/theme/episode/servers), bukan ditulis langsung di HTML. Tiap tautan server
 * membawa `data-hash` yang ditukar jadi URL embed via /api/theme/episode/source.
 */
async function episodeTheme(episodeId: string | null): Promise<ThemeServers | null> {
  if (!episodeId) return null;
  try {
    return await fetchJson<ThemeServers>(
      `${BASE}/api/theme/episode/servers?episodeId=${encodeURIComponent(episodeId)}`,
      { headers: browserHeaders(REFERER, THEME_HEADERS) },
      15000,
    );
  } catch {
    return null;
  }
}

/** Tukar data-hash server jadi URL embed yang bisa dipasang di iframe. */
async function resolveSource(hash: string): Promise<string | null> {
  try {
    const res = await fetchJson<{ status?: boolean; url?: string }>(
      `${BASE}/api/theme/episode/source?get=${encodeURIComponent(hash)}`,
      { headers: browserHeaders(`${BASE}/`, THEME_HEADERS) },
      15000,
    );
    return res?.status && res.url ? httpsUrl(res.url) : null;
  } catch {
    return null;
  }
}

/** Daftar server dari blok HTML API /episode/servers. */
function serverRefs($: CheerioAPI, html: string): { name: string; hash: string }[] {
  const out: { name: string; hash: string }[] = [];
  if (!html) return out;
  const seen = new Set<string>();
  load(html)(".server-item a[data-hash]").each((_, a) => {
    const el = $(a);
    const hash = clean(el.attr("data-hash"));
    if (!hash || seen.has(hash)) return;
    seen.add(hash);
    out.push({ name: clean(el.text()) || `Server ${out.length + 1}`, hash });
  });
  return out;
}

/**
 * Server player episode. Anichin memuatnya lewat API JSON internal
 * (/api/theme/episode/servers) lalu menukar `data-hash` jadi URL embed lewat
 * /api/theme/episode/source. Sebagian halaman juga menaruh iframe langsung.
 */
async function servers($: CheerioAPI): Promise<Server[]> {
  const refs = serverRefs($, (await episodeTheme(episodeId($)))?.html ?? "");
  const resolved = await Promise.all(refs.map((r) => resolveSource(r.hash)));
  const out: Server[] = [];
  const seen = new Set<string>();
  refs.forEach((ref, i) => {
    const url = resolved[i];
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ index: out.length + 1, name: ref.name, url, iframe: iframeTag(url) });
  });
  if (out.length) return out;

  // Cadangan: iframe yang sudah ada di HTML.
  $("#pembed iframe, .player-embed iframe, .video-content iframe, .megavid iframe").each((_, f) => {
    const el = $(f);
    const url = httpsUrl(el.attr("src") || el.attr("data-src") || el.attr("data-litesite-src"));
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ index: out.length + 1, name: out.length ? `Server ${out.length + 1}` : "Default", url, iframe: iframeTag(url) });
  });
  return out;
}

type Download = { title: string | null; quality: string | null; links: { name: string; url: string }[] };

/** Link unduhan dari blok .soraddlx (HTML statis di halaman atau dari API /episode/servers). */
function downloadsFrom(html: string): Download[] {
  const out: Download[] = [];
  if (!html) return out;
  const $d = load(html);
  $d(".soraddlx, .soraddl").each((_, box) => {
    const title = clean($d(box).find(".sorattlx, .sorattl").first().text()) || null;
    $d(box)
      .find(".soraurlx, .soraurl")
      .each((_, row) => {
        const links = $d(row)
          .find("a[href]")
          .map((_, a) => {
            const url = absUrl($d(a).attr("href"), BASE);
            return url ? { name: clean($d(a).text()), url } : null;
          })
          .get()
          .filter((x): x is { name: string; url: string } => Boolean(x));
        if (links.length) out.push({ title, quality: clean($d(row).find("strong, .res").first().text()) || null, links });
      });
  });
  return out;
}

/** Unduhan: pakai HTML halaman bila ada, kalau kosong ambil dari API internal. */
async function downloads($: CheerioAPI, theme: ThemeServers | null): Promise<Download[]> {
  const local = downloadsFrom($.html());
  if (local.length) return local;
  return downloadsFrom(theme?.downloads ?? "");
}

/** Metadata seri dari blok .single-info / .bigcontent (ada di halaman seri maupun episode). */
function seriesInfo($: CheerioAPI) {
  const scope = $(".single-info, .bigcontent").first();
  if (!scope.length) return null;
  const meta: Record<string, string> = {};
  scope.find(".spe span").each((_, s) => {
    const text = clean($(s).text());
    const i = text.indexOf(":");
    if (i > 0) meta[text.slice(0, i).trim()] = text.slice(i + 1).trim();
  });
  const rating = clean(scope.find(".rating strong").first().text()).replace(/^Rating\s*/i, "");
  const epCount = Number(meta["Episode"] ?? meta["Episodes"] ?? meta["Episodes:"]);
  const synopsis =
    clean(scope.find(".desc").first().text()) ||
    clean($(".synp .entry-content, .entry-content[itemprop='description'], #synopsis p").first().text());
  const genres = scope.find(".genxed a").map((_, g) => clean($(g).text())).get().filter(Boolean);
  const link = (label: string) => {
    const a = scope.find(`.spe span a`).filter((_, el) => clean($(el).text()) === label).first();
    const slug = pathParts(a.attr("href"), BASE).pop();
    return slug ? { slug, name: clean(a.text()) } : null;
  };
  return {
    title: clean(scope.find(".infox h1, .infox h2, h1.entry-title, .entry-title").first().text()) || null,
    alternative_titles: clean(scope.find(".alter, .jname, .native-title").first().text()) || null,
    poster: imgSrc(scope.find(".thumb img, .banner img, img").first(), BASE),
    rating: rating && Number.isFinite(Number(rating)) ? Number(rating) : rating || null,
    status: meta["Status"] ?? null,
    type: meta["Type"] ?? meta["Tipe"] ?? null,
    released: meta["Released"] ?? meta["Dirilis"] ?? null,
    season: meta["Season"] ?? null,
    duration: meta["Duration"] ?? meta["Durasi"] ?? null,
    network: meta["Network"] ?? null,
    country: meta["Country"] ?? null,
    fansub: meta["Fansub"] ?? null,
    studio: meta["Studio"] ?? null,
    total_episodes: Number.isFinite(epCount) ? epCount : meta["Episodes"] ?? null,
    genres,
    studio_ref: link(meta["Studio"] ?? ""),
    season_ref: link(meta["Season"] ?? ""),
    synopsis: synopsis || null,
    updated_on: meta["Updated on"] ?? null,
  };
}

function episodeNumber(text: string): string | null {
  return clean(text).match(/Episode\s+([\d.]+)/i)?.[1] ?? clean(text).match(/\bEp\.?\s*([\d.]+)/i)?.[1] ?? null;
}

/** Daftar episode. `jdlul`/`eplister` (halaman seri) atau `episodelist` (halaman episode). */
function episodeList($: CheerioAPI): EpisodeRef[] {
  const out: EpisodeRef[] = [];
  const seen = new Set<string>();
  $(".eplister li, .episodelist li, .bixbox .eplister ul li").each((_, li) => {
    const el = $(li);
    const ref = classify(el.find("a[href]").first().attr("href"));
    if (!ref || ref.kind !== "episode" || seen.has(ref.slug)) return;
    seen.add(ref.slug);
    const numText = clean(el.find(".epl-num").first().text());
    const title = clean(el.find(".epl-title").first().text()) || clean(el.find("a").first().attr("title")) || ref.slug;
    const date = clean(el.find(".epl-date").first().text()) || null;
    out.push({ episode: numText || episodeNumber(title), title, slug: ref.slug, url: ref.url, date });
  });
  return out;
}

/**
 * Halaman seri punya carousel episode yang dimuat belakangan (lazy), jadi sebagian daftar
 * episode tidak ada di HTML pertama. Halaman episode pertama biasanya memuat daftar lengkap
 * di dalam <select> navigasi, jadi itu dipakai sebagai pelengkap.
 */
function episodesFromNav($: CheerioAPI): EpisodeRef[] {
  const out: EpisodeRef[] = [];
  const seen = new Set<string>();
  $("select option, .nvsc a[href], .naveps a[href], .epnavigation a[href]").each((_, node) => {
    const el = $(node);
    const href = el.attr("data-href") || el.attr("value") || el.attr("href");
    const ref = classify(href);
    if (!ref || ref.kind !== "episode" || seen.has(ref.slug)) return;
    seen.add(ref.slug);
    const title = clean(el.attr("data-title") || el.text());
    out.push({ episode: episodeNumber(title) ?? title.match(/^(\d+)$/)?.[1] ?? null, title: title || ref.slug, slug: ref.slug, url: ref.url, date: null });
  });
  return out;
}

async function tryPage(url: string): Promise<Page | null> {
  try {
    return await fetchPage(url, REFERER);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

function isEpisodePage($: CheerioAPI): boolean {
  return $("select.mirror, #as-servers, #pembed, .player-embed, .episodelist, .megavid").length > 0;
}

async function loadEpisode(slug: string): Promise<Page> {
  const page = await tryPage(episodeUrl(slug));
  if (!page || !isEpisodePage(page.$)) {
    throw new HttpError(404, "Episode tidak ditemukan. Gunakan slug episode dari endpoint latest/detail-anime.");
  }
  return page;
}

function seriesRefFromEpisode($: CheerioAPI): { slug: string; url: string; title: string | null } | null {
  let found: { slug: string; url: string; title: string | null } | null = null;
  $(".breadcrumb a[href], .ts-breadcrumb a[href], .single-info a[href], .naveps a[href], .year a[href]").each((_, a) => {
    if (found) return;
    const ref = classify($(a).attr("href"));
    if (ref?.kind === "series") found = { slug: ref.slug, url: ref.url, title: clean($(a).text()) || null };
  });
  return found;
}

/** Halaman seri: /anime/<slug>. Bila slug ternyata episode, pakai seri yang tertaut di halamannya. */
async function loadSeries(slug: string, hint: "series" | "episode" | null): Promise<{ page: Page; via: "series" | "episode" }> {
  if (hint !== "episode") {
    const series = await tryPage(seriesUrl(slug));
    if (series && series.$(".single-info, .bigcontent, .eplister").length > 0) return { page: series, via: "series" };
  }
  if (hint !== "series") {
    const ep = await tryPage(episodeUrl(slug));
    if (ep && isEpisodePage(ep.$)) return { page: ep, via: "episode" };
  }
  throw new HttpError(404, "Donghua tidak ditemukan. Gunakan slug dari endpoint daftar atau cari.");
}

function navRef($: CheerioAPI, rel: "prev" | "next") {
  const href =
    $(`.naveps a[rel="${rel}"]`).first().attr("href") ??
    $(`.naveps .nvsc a`).filter((_, a) => clean($(a).text()).toLowerCase().includes(rel === "prev" ? "prev" : "next")).first().attr("href");
  const ref = classify(href);
  return ref?.kind === "episode" ? { slug: ref.slug, url: ref.url } : null;
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
<iframe src="${escapeHtml(url)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>
</body>
</html>`;
}

const GENRE_OPTIONS = [
  "action", "adventure", "comedy", "cultivation", "demons", "drama", "fantasy", "friendship", "game", "gourmet",
  "historical", "horror", "isekai", "magic", "martial-arts", "mystery", "psychological", "romance", "school",
  "sci-fi", "slice-of-life", "supernatural", "super-power", "suspense", "thriller", "time-travel", "urban-fantasy", "video-game",
];

const ORDER_OPTIONS = ["update", "latest", "added", "popular", "rating", "title", "titlereverse"];

export const donghuaEndpoints: Endpoint[] = [
  {
    category: "donghua",
    slug: "home",
    kind: "json",
    title: "Beranda Donghua",
    description:
      "Semua bagian beranda Anichin sekaligus: popular today, latest release, dan bagian lain yang sedang tampil, lengkap dengan poster, tipe, status, dan episode terakhir.",
    params: [],
    handler: async () => {
      const { $ } = await fetchPage(REFERER, REFERER);
      const all = sections($).filter((s) => s.name);
      if (!all.length) throw new HttpError(502, "Struktur halaman Anichin berubah, beranda tidak terbaca.");
      return {
        source: BASE,
        total_sections: all.length,
        sections: all.map((s) => ({ name: s.name, total: s.items.length, items: s.items })),
      };
    },
  },
  {
    category: "donghua",
    slug: "latest",
    kind: "json",
    title: "Episode Donghua Terbaru",
    description: "Episode donghua sub Indo yang baru dirilis di Anichin. Slug hasilnya bisa langsung dipakai di endpoint episode.",
    params: [{ name: "page", description: "Nomor halaman (1-100).", example: "1" }],
    handler: async ({ sp }) => {
      const page = Math.floor(num(sp, "page", 1, 1, 100));
      const { $ } = page > 1 ? await fetchPage(`${BASE}/anime?page=${page}&order=update`, REFERER) : await fetchPage(REFERER, REFERER);
      const all = sections($);
      const section =
        all.find((s) => /latest release|rilisan terbaru/i.test(s.name)) ??
        all.find((s) => /terbaru|latest/i.test(s.name)) ??
        [...all].sort((a, b) => b.items.length - a.items.length)[0];
      if (!section) throw new HttpError(502, "Struktur halaman Anichin berubah, episode terbaru tidak terbaca.");
      return { source: BASE, page, has_next: hasNextPage($, page), total: section.items.length, items: section.items };
    },
  },
  {
    category: "donghua",
    slug: "popular",
    kind: "json",
    title: "Donghua Populer",
    description: "Seri donghua paling populer di Anichin, diambil dari daftar berurutan 'Popular'.",
    params: [{ name: "page", description: "Nomor halaman (1-50).", example: "1" }],
    handler: async ({ sp }) => {
      const page = Math.floor(num(sp, "page", 1, 1, 50));
      const { $ } = await fetchPage(`${BASE}/anime?order=popular${page > 1 ? `&page=${page}` : ""}`, REFERER);
      const items = cards($);
      if (!items.length) throw new HttpError(502, "Daftar donghua populer tidak terbaca dari Anichin.");
      return { source: BASE, page, has_next: hasNextPage($, page), total: items.length, items };
    },
  },
  {
    category: "donghua",
    slug: "list",
    kind: "json",
    title: "Daftar Donghua",
    description: "Jelajahi pustaka Anichin dengan filter genre, musim, studio, status, tipe, subtitle, dan urutan. Mendukung halaman.",
    params: [
      { name: "page", description: "Nomor halaman (1-200).", example: "1" },
      { name: "genre", description: `Slug genre, mis. action. Pilihan: ${GENRE_OPTIONS.join(", ")}.`, example: "action" },
      { name: "order", description: `Urutan: ${ORDER_OPTIONS.join(", ")}. Default popular.`, example: "popular" },
      { name: "status", description: "ongoing, completed, atau upcoming.", example: "" },
      { name: "type", description: "tv, movie, ova, ona, special, atau music.", example: "" },
      { name: "season", description: "Slug musim, mis. summer-2026.", example: "" },
      { name: "studio", description: "Slug studio, mis. build-dream.", example: "" },
    ],
    handler: async ({ sp }) => {
      const page = Math.floor(num(sp, "page", 1, 1, 200));
      const genre = opt(sp, "genre").toLowerCase();
      const order = opt(sp, "order", "popular").toLowerCase();
      const status = opt(sp, "status").toLowerCase();
      const type = opt(sp, "type").toLowerCase();
      const season = opt(sp, "season").toLowerCase();
      const studio = opt(sp, "studio").toLowerCase();
      if (genre && !/^[a-z0-9-]{1,60}$/.test(genre)) throw new HttpError(400, "Parameter 'genre' tidak valid.");
      if (!ORDER_OPTIONS.includes(order)) throw new HttpError(400, `Parameter 'order' harus salah satu: ${ORDER_OPTIONS.join(", ")}.`);
      if (status && !["ongoing", "completed", "upcoming"].includes(status)) throw new HttpError(400, "Parameter 'status' harus ongoing, completed, atau upcoming.");
      if (type && !["tv", "movie", "ova", "ona", "special", "music"].includes(type)) throw new HttpError(400, "Parameter 'type' harus tv, movie, ova, ona, special, atau music.");
      const path = genre ? `/genres/${genre}` : season ? `/season/${season}` : studio ? `/studios/${studio}` : "/anime";
      const qs = new URLSearchParams();
      if (page > 1) qs.set("page", String(page));
      if (order) qs.set("order", order);
      if (status) qs.set("status", status);
      if (type) qs.set("type", type);
      const { $ } = await fetchPage(`${BASE}${path}${qs.size ? `?${qs}` : ""}`, REFERER);
      let items = cards($);
      if (type) items = items.filter((i) => (i.type ?? "").toLowerCase() === type);
      if (!items.length) throw new HttpError(502, "Daftar donghua tidak terbaca. Periksa kembali genre/season/studio yang dipakai.");
      return {
        source: BASE,
        page,
        has_next: hasNextPage($, page),
        filter: { genre: genre || null, season: season || null, studio: studio || null, status: status || null, type: type || null, order },
        total: items.length,
        items,
      };
    },
  },
  {
    category: "donghua",
    slug: "search",
    kind: "json",
    title: "Cari Donghua",
    description: "Cari judul donghua di Anichin. Hasil berisi slug seri yang dipakai di endpoint detail-anime.",
    params: [
      { name: "q", required: true, description: "Kata kunci judul.", example: "renegade immortal" },
      { name: "page", description: "Nomor halaman hasil (1-50).", example: "1" },
    ],
    handler: async ({ sp }) => {
      const q = need(sp, "q", 100);
      const page = Math.floor(num(sp, "page", 1, 1, 50));
      const res = await tryPage(searchUrl(q, page));
      const items = res ? cards(res.$) : [];
      return { source: BASE, query: q, page, has_next: res ? hasNextPage(res.$, page) : false, total: items.length, items };
    },
  },
  {
    category: "donghua",
    slug: "genre",
    kind: "json",
    title: "Daftar Genre Donghua",
    description: "Semua genre donghua yang tersedia di Anichin beserta slug yang bisa dipakai di endpoint list.",
    params: [],
    handler: async () => {
      const { $ } = await fetchPage(`${BASE}/anime`, REFERER);
      const found = $("input[name='genre[]'], select[name='genre'] option, .genres li a")
        .map((_, el) => {
          const value = clean($(el).attr("value") ?? clean($(el).attr("href"))).replace(/^.*\/genres\//, "").replace(/\/$/, "");
          const name = clean($(el).text()) || value;
          return value ? { slug: value, name } : null;
        })
        .get()
        .filter(Boolean);
      // Daftar genre bisa muncul dua kali (panel filter + pilihan lanjutan): buang duplikat.
      const unique = new Map<string, { slug: string; name: string }>();
      for (const g of found) if (g && !unique.has(g.slug)) unique.set(g.slug, g);
      const genres = unique.size
        ? [...unique.values()].map((g) => ({ slug: g.slug, name: g.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) }))
        : GENRE_OPTIONS.map((slug) => ({ slug, name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) }));
      return { source: BASE, total: genres.length, genres };
    },
  },
  {
    category: "donghua",
    slug: "schedule",
    kind: "json",
    title: "Jadwal Rilis Donghua",
    description: "Jadwal perkiraan rilis episode mingguan Anichin, dikelompokkan per hari, lengkap dengan seri dan episode terakhirnya.",
    params: [],
    handler: async () => {
      const { $ } = await fetchPage(`${BASE}/schedule`, REFERER);
      type DayItem = { title: string; slug: string; url: string; poster: string | null; episode: string | null; time: string | null; state: string | null };
      const days: { day: string; total: number; items: DayItem[] }[] = [];
      let current: { day: string; total: number; items: DayItem[] } | null = null;
      $("h3, h4, .schedulepage .bs, .bixbox .bs, .schedule .bs").each((_, node) => {
        const el = $(node);
        if (/^h[34]$/i.test(node.tagName ?? "")) {
          const name = clean(el.text());
          if (!name) return;
          current = { day: name, total: 0, items: [] };
          days.push(current);
          return;
        }
        const day = current as { day: string; total: number; items: DayItem[] } | null;
        const a = el.find('a[href*="/anime/"]').first();
        const slug = pathParts(a.attr("href"), BASE).pop();
        if (!slug || !day) return;
        // .limit berisi "Released 167" (sudah tayang) atau jam rilis "04:35 168" (belum tayang).
        const parts = el
          .find(".limit > *")
          .map((_, c) => clean($(c).text()))
          .get()
          .filter(Boolean);
        const label = parts.length >= 2 ? parts.join(" ") : clean(el.find(".limit").first().text());
        const released = /released/i.test(label);
        const time = released ? null : label.match(/\b(\d{1,2}:\d{2})\b/)?.[1] ?? null;
        const number = label.replace(/released/i, "").match(/(\d{1,4})\s*$/)?.[1] ?? null;
        day.items.push({
          title: clean(el.find(".tt h2, .tt, .ntitle").first().text()) || clean(a.attr("title")) || slug,
          slug,
          url: seriesUrl(slug),
          poster: imgSrc(el.find("img").first(), BASE),
          episode: number,
          time,
          state: released ? "released" : "upcoming",
        });
        day.total = day.items.length;
      });
      const filtered = days.filter((d) => d.items.length);
      if (!filtered.length) throw new HttpError(502, "Jadwal Anichin tidak terbaca.");
      return { source: `${BASE}/schedule`, total_days: filtered.length, days: filtered };
    },
  },
  {
    category: "donghua",
    slug: "detail-anime",
    // Alias `detail` supaya seragam dengan kategori anime/film (registry memakai yang pertama mendaftar).
    aliases: ["detail"],
    kind: "json",
    title: "Detail Donghua",
    description:
      "Metadata lengkap satu seri donghua: judul, judul alternatif, sinopsis, genre, studio, network, musim, status, rating, poster, dan daftar seluruh episode.",
    params: [{ name: "slug", required: true, description: "Slug seri dari daftar/cari, slug episode, atau URL anichin lengkap.", example: "renegade-immortal" }],
    handler: async ({ sp }) => {
      const { slug, hint } = slugParam(need(sp, "slug", 400));
      const { page, via } = await loadSeries(slug, hint);
      const { $ } = page;
      const info = seriesInfo($);
      if (!info) throw new HttpError(502, "Metadata donghua tidak terbaca dari Anichin.");
      const series = via === "series" ? { slug, url: seriesUrl(slug), title: info.title } : seriesRefFromEpisode($) ?? { slug, url: seriesUrl(slug), title: null };
      let episodes = episodeList($);
      // Halaman seri memuat carousel episode secara lazy; lengkapi dari <select> navigasi episode.
      if (episodes.length < 30) {
        const first = episodes[episodes.length - 1] ?? episodes[0];
        if (first) {
          const ep = await tryPage(first.url).catch(() => null);
          if (ep) {
            const seen = new Set(episodes.map((e) => e.slug));
            const extra = episodesFromNav(ep.$).filter((e) => !seen.has(e.slug) && e.slug.startsWith(`${series.slug}-episode`));
            episodes = [...episodes, ...extra];
            episodes.sort((a, b) => (Number(b.episode) || 0) - (Number(a.episode) || 0));
          }
        }
      }
      return {
        source: series.url,
        slug: series.slug,
        ...info,
        title: info.title || series.title,
        available_episodes: episodes.length,
        first_episode: episodes[episodes.length - 1] ?? null,
        latest_episode: episodes[0] ?? null,
        episodes,
      };
    },
  },
  {
    category: "donghua",
    slug: "episode",
    kind: "json",
    title: "Nonton Episode Donghua",
    description:
      "Link player episode donghua (siap dipasang di iframe), navigasi episode sebelum/sesudah, link unduhan, dan metadata serinya.",
    params: [
      { name: "slug", required: true, description: "Slug episode dari latest/detail-anime atau URL episode lengkap.", example: "renegade-immortal-episode-167" },
      { name: "server", description: "Pilih satu server saja (mulai 1). Kosongkan untuk semua server.", example: "" },
    ],
    handler: async ({ sp, origin }) => {
      const { slug } = slugParam(need(sp, "slug", 400));
      const want = opt(sp, "server") ? Math.floor(num(sp, "server", 1, 1, 60)) : 0;
      const { $ } = await loadEpisode(slug);
      const theme = await episodeTheme(episodeId($));
      const list = await servers($);
      const info = seriesInfo($);
      const series = seriesRefFromEpisode($);
      const title = clean($("h1.entry-title, h1").first().text()) || null;
      const embed = `${origin}/api/donghua/embed?slug=${encodeURIComponent(slug)}`;
      const chosen = want ? list[want - 1] : null;
      if (want && !chosen) throw new HttpError(404, `Server ${want} tidak tersedia. Episode ini punya ${list.length} server.`);
      return {
        source: episodeUrl(slug),
        slug,
        title,
        episode: episodeNumber(title ?? "") ?? (clean($(".epx").first().text()) || null),
        released:
          clean($(".year .updated, .updated, .episodelist .epl-date").first().text()) ||
          clean($("body").text()).match(/Released on ([A-Za-z]+ \d{1,2}, \d{4})/)?.[1] ||
          null,
        series: series ? { slug: series.slug, title: info?.title ?? series.title, url: series.url } : info?.title ? { slug: null, title: info.title, url: null } : null,
        player: {
          total_servers: list.length,
          default: chosen?.url ?? list[0]?.url ?? null,
          embed: list.length ? (want ? `${embed}&server=${want}` : embed) : null,
          embed_iframe: list.length ? iframeTag(want ? `${embed}&server=${want}` : embed) : null,
          servers: chosen ? [chosen] : list,
        },
        prev_episode: navRef($, "prev"),
        next_episode: navRef($, "next"),
        downloads: await downloads($, theme),
        info,
      };
    },
  },
  {
    category: "donghua",
    slug: "embed",
    kind: "html",
    title: "Embed Player Donghua",
    description: "Halaman HTML berisi player video episode, layar penuh. Pakai URL ini langsung sebagai src <iframe> di situsmu.",
    params: [
      { name: "slug", required: true, description: "Slug episode (dari latest/episode).", example: "renegade-immortal-episode-167" },
      { name: "server", description: "Nomor server player, mulai dari 1.", example: "1" },
    ],
    handler: async ({ sp }) => {
      const { slug } = slugParam(need(sp, "slug", 400));
      const want = Math.floor(num(sp, "server", 1, 1, 60));
      const { $ } = await loadEpisode(slug);
      const list = await servers($);
      if (!list.length) throw new HttpError(404, "Player video untuk episode ini tidak ditemukan.");
      const server = list[want - 1];
      if (!server) throw new HttpError(404, `Server ${want} tidak tersedia. Episode ini punya ${list.length} server.`);
      const title = clean($("h1.entry-title, h1").first().text()) || "Player";
      return new Response(embedHtml(title, server.url), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300, s-maxage=600",
          "content-security-policy": "default-src 'none'; frame-src https:; style-src 'unsafe-inline'; frame-ancestors *",
          "x-robots-tag": "noindex",
        },
      });
    },
  },
  {
    category: "donghua",
    slug: "image",
    kind: "image",
    title: "Proxy Gambar Donghua",
    description: "Tampilkan poster/j gambar dari server Anichin lewat proxy (mengatasi blokir hotlink). Hanya menerima host anichin.",
    params: [{ name: "url", required: true, description: "URL gambar dari endpoint lain di kategori ini.", example: "https://anichin.ro/storage/media/2026/10/renegade-immortal.webp" }],
    handler: async ({ sp }) => {
      const raw = need(sp, "url", 1000);
      const u = absUrl(raw, BASE);
      let parsed: URL | null = null;
      try {
        parsed = u ? new URL(u) : null;
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.protocol !== "https:" || !IMAGE_HOSTS.test(parsed.hostname)) {
        throw new HttpError(400, "Hanya URL gambar https dari host anichin yang diizinkan.");
      }
      const res = await fetchRaw(parsed.toString(), { headers: browserHeaders(REFERER, { accept: "image/avif,image/webp,image/*,*/*;q=0.8" }) }, 20000);
      const type = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
      if (!type.startsWith("image/")) throw new HttpError(502, "Server sumber tidak mengirim gambar.");
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 4_300_000) throw new HttpError(413, "Gambar terlalu besar untuk diproxy (maks ±4 MB). Gunakan URL aslinya.");
      return binaryResponse(buf, type, "public, max-age=86400, s-maxage=604800, immutable");
    },
  },
];
