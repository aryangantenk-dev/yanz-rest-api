import { load, type CheerioAPI } from "cheerio";
import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { binaryResponse, fetchRaw, need, num, opt } from "./helpers";
import { absUrl, browserHeaders, clean, cleanSlug, fetchPage, imgSrc, pathParts, type El, type Page } from "./scrape";

/*
  Sumber: https://bacaln.com — novel bahasa Indonesia (WordPress, tema Madara).

  Markup tema Madara berbeda antar-situs (nama kelas kartu bisa diganti pemilik situs),
  jadi modul ini sengaja TIDAK bergantung pada nama kelas kartu. Yang dipakai hanya pola
  yang selalu ada di Madara:
  - tautan seri   : /series/<slug>/
  - tautan chapter: /<judul>-chapter-<n>/  (langsung di akar domain, tanpa /series/)
  - info seri     : daftar <li> berlabel "Judul:", "Status:", "Penulis:", "Genre:", "Score:"
  - isi bacaan    : kontainer dengan paragraf terbanyak di halaman chapter
*/
const BASE = "https://bacaln.com";
const REFERER = `${BASE}/`;
const IMAGE_HOSTS = /(^|\.)(bacaln\.com|wp\.com)$/i;
/** Segmen path yang bukan seri, supaya tautan menu tidak ikut terbaca. */
const RESERVED = new Set([
  "series", "genre", "page", "cari-novel", "feed", "wp-json", "wp-admin", "wp-content", "wp-includes",
  "wp-login.php", "tag", "author", "bookmark", "s", "search", "category", "light-novel", "web-novel",
  "daftar-novel", "semua-novel", "advanced-search", "sitemap.xml", "komentar", "kontak", "dmca", "privacy",
]);

const seriesUrl = (slug: string) => `${BASE}/series/${encodeURIComponent(slug)}/`;
const searchUrl = (q: string, page: number) => `${BASE}/?s=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ""}`;
const homeUrl = (page: number) => (page > 1 ? `${BASE}/page/${page}/` : `${BASE}/`);

type Ref = { kind: "series" | "chapter"; slug: string; url: string };

/** Kenali tautan seri dan chapter atas dasar bentuk path, bukan kelas CSS. */
function classify(href: string | null | undefined): Ref | null {
  if (!href) return null;
  let parts: string[];
  try {
    const u = new URL(href, BASE);
    if (u.hostname !== new URL(BASE).hostname) return null;
    parts = pathParts(u.pathname, BASE);
  } catch {
    return null;
  }
  if (!parts.length) return null;
  if (parts[0] === "series" && parts[1]) return { kind: "series", slug: parts[1], url: seriesUrl(parts[1]) };
  const last = parts[parts.length - 1];
  if (parts.length === 1 && !RESERVED.has(last) && /-chapter-\d+$/i.test(last)) {
    return { kind: "chapter", slug: last, url: `${BASE}/${encodeURIComponent(last)}/` };
  }
  return null;
}

/** Nomor chapter dari teks label ("Ch.184", "Bab 184") atau dari slug. */
function chapterNumber(...values: (string | null | undefined)[]): number | null {
  for (const v of values) {
    const m = clean(v).match(/(?:chapter|ch\.?|bab)\s*[-_ ]?\s*(\d+(?:[.,]\d+)?)/i) ?? clean(v).match(/-chapter-(\d+(?:\.\d+)?)/i);
    if (m) return Number(m[1].replace(",", "."));
  }
  return null;
}

/** Nama seri dari slug chapter: buang akhiran -chapter-<n>. */
const seriesFromChapterSlug = (slug: string) => slug.replace(/-chapter-\d+$/i, "");

/** Judul manusiawi dari slug (dipakai bila nama asli tidak terbaca). */
function titleize(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Naik dari sebuah elemen sampai ketemu blok yang memuat gambar + genre + judul. */
function blockOf($: CheerioAPI, el: El, maxDepth = 6): El {
  let node = el;
  for (let i = 0; i < maxDepth; i++) {
    const parent = node.parent();
    if (!parent.length || parent.is("body, html")) break;
    node = parent;
    if (node.find('a[href*="/genre/"]').length || node.find("img").length > 0) {
      // Berhenti di blok pertama yang memuat satu kartu saja (bukan seluruh daftar).
      if (node.find('a[href*="/series/"]').length <= 1) return node;
    }
  }
  return node;
}

type Card = {
  title: string;
  slug: string;
  url: string;
  poster: string | null;
  genres: string[];
  latest_chapter: number | null;
  latest_chapter_url: string | null;
  author: string | null;
  status: string | null;
  synopsis: string | null;
};

/** Ambil URL gambar pertama yang benar-benar gambar sampul (bukan ikon/lazy placeholder). */
function coverOf($: CheerioAPI, scope: El): string | null {
  let out: string | null = null;
  scope.find("img").each((_, img) => {
    if (out) return;
    const el = $(img);
    const alt = clean(el.attr("alt"));
    // Ikon tema Madara biasanya bernama "loading" atau berukuran kecil dan tidak punya path upload.
    const src = imgSrc(el, BASE);
    if (!src) return;
    const looksLikeCover = /\/wp-content\/uploads\//.test(src) || /bacaln\.com\/(wp-content|novel)/.test(src);
    if (looksLikeCover || /cover|thumb|poster/i.test(alt) || /cover|thumb|poster/i.test(`${el.attr("class") ?? ""}`)) out = src;
  });
  return out;
}

/** Genre di dalam satu blok kartu. */
function genresOf($: CheerioAPI, scope: El): string[] {
  const out: string[] = [];
  scope.find('a[href*="/genre/"]').each((_, a) => {
    const name = clean($(a).text());
    if (name && !out.includes(name)) out.push(name);
  });
  return out;
}

/**
 * Kartu seri dari halaman beranda/pencarian/genre.
 * Dikelompokkan per tautan /series/ unik; setiap judul diambil dari teks tautan,
 * lalu alt gambar, lalu slug sebagai jalan terakhir.
 */
function cards($: CheerioAPI, limit = 40): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  $('a[href*="/series/"]').each((_, a) => {
    if (out.length >= limit) return;
    const link = $(a);
    const ref = classify(link.attr("href"));
    if (!ref || ref.kind !== "series" || seen.has(ref.slug)) return;
    seen.add(ref.slug);
    const block = blockOf($, link);
    const heading = clean(block.find("h1, h2, h3, h4, .post-title").first().text());
    const title =
      clean(link.attr("title")) ||
      heading ||
      clean(block.find("img").first().attr("alt")) ||
      titleize(ref.slug);
    const chapterLink = block.find('a[href*="-chapter-"]').first();
    out.push({
      title: title.replace(/\s+Bahasa Indonesia\s*$/i, "").trim(),
      slug: ref.slug,
      url: ref.url,
      poster: coverOf($, block),
      genres: genresOf($, block),
      latest_chapter: chapterNumber(clean(chapterLink.text()), chapterLink.attr("href")),
      latest_chapter_url: classify(chapterLink.attr("href"))?.url ?? null,
      author: labeled($, block, ["penulis", "author"]),
      status: labeled($, block, ["status"]),
      synopsis: clean(block.find(".post-content, .description-summary, p").last().text()).slice(0, 400) || null,
    });
  });
  return out;
}

/** Baca baris berlabel ("Status: Ongoing") dari daftar <li> atau blok .post-content_item. */
function labeled($: CheerioAPI, scope: El, labels: string[]): string | null {
  let found: string | null = null;
  scope.find("li, .post-content_item, .summary-content, .mg_author, .mg_status").each((_, node) => {
    if (found) return;
    const el = $(node);
    const heading = clean(el.find(".summary-heading").text()).replace(/:$/, "").toLowerCase();
    if (heading && labels.some((l) => heading.includes(l))) {
      found = clean(el.find(".summary-content").text()) || null;
      return;
    }
    const text = clean(el.clone().find("ul, li").remove().end().text());
    const m = text.match(/^([^:]{2,20}):\s*(.+)$/);
    if (m && labels.some((l) => m[1].toLowerCase().includes(l)) && m[2].trim()) found = m[2].trim();
  });
  return found;
}

type Chapter = { chapter: number | null; title: string; slug: string; url: string; date: string | null };

/** Seluruh chapter di halaman seri, urut naik. Hanya bergantung pada bentuk URL chapter. */
function chaptersOf($: CheerioAPI): Chapter[] {
  const out: Chapter[] = [];
  const seen = new Set<string>();
  $('a[href*="-chapter-"]').each((_, a) => {
    const el = $(a);
    const ref = classify(el.attr("href"));
    if (!ref || ref.kind !== "chapter" || seen.has(ref.slug)) return;
    seen.add(ref.slug);
    const label = clean(el.text());
    const n = chapterNumber(label, ref.slug);
    out.push({
      chapter: n,
      title: label || (n === null ? ref.slug : `Ch.${n}`),
      slug: ref.slug,
      url: ref.url,
      date: clean(el.closest("li, .chapter-item, tr").find(".chapter-release-date, .post-on, time").first().text()) || null,
    });
  });
  return out.sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0));
}

/** Terima slug polos, URL seri, atau URL chapter. */
function target(raw: string): { ref: Ref; chapter: number | null } {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    const ref = classify(v);
    if (!ref) throw new HttpError(400, "URL bacaln tidak dikenali. Kirim URL /series/<slug>/ atau /<judul>-chapter-<n>/.");
    return { ref, chapter: ref.kind === "chapter" ? chapterNumber(ref.slug) : null };
  }
  const cleaned = cleanSlug(v.replace(/^\/+(series\/)?/i, ""), "slug");
  const direct = classify(`/${cleaned}/`);
  if (direct) return { ref: direct, chapter: direct.kind === "chapter" ? chapterNumber(cleaned) : null };
  if (/-chapter-\d+$/i.test(cleaned)) {
    return { ref: { kind: "chapter", slug: cleaned, url: `${BASE}/${encodeURIComponent(cleaned)}/` }, chapter: chapterNumber(cleaned) };
  }
  return { ref: { kind: "series", slug: cleaned, url: seriesUrl(cleaned) }, chapter: null };
}

async function page(url: string): Promise<Page> {
  try {
    return await fetchPage(url, REFERER);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(404, "Halaman bacaln tidak ditemukan.");
    throw new HttpError(502, "Situs bacaln tidak bisa dihubungi. Coba lagi beberapa saat lagi.");
  }
}

/**
 * Isi bacaan satu chapter. Kontainer bacaan dicari dari yang paling spesifik ke paling umum,
 * lalu jatuh ke blok dengan paragraf terbanyak — Madara mengganti nama kelas kontainernya
 * di beberapa situs, jadi jumlah paragraf lebih dapat dipercaya daripada nama kelas.
 */
async function readChapter(url: string) {
  const { $, url: finalUrl } = await page(url);
  $("script, style, noscript, ins, iframe").remove();

  let scope: El | null = null;
  for (const sel of [".reading-content", ".entry-content", "div.text-left", "#chapter-content", ".chapter-content"]) {
    const el = $(sel).first();
    if (el.length && el.find("p").length >= 1) {
      scope = el;
      break;
    }
  }
  if (!scope) {
    let best = 0;
    $("div, article, section").each((_, node) => {
      const n = $(node).find("p").length;
      if (n > best) {
        best = n;
        scope = $(node);
      }
    });
  }
  if (!scope) throw new HttpError(502, "Halaman chapter bacaln tidak memuat teks bacaan.");

  const paragraphs: string[] = [];
  scope.find("p").each((_, p) => {
    const t = clean($(p).text());
    // Buang baris navigasi/iklan yang ikut terpungut.
    if (t.length < 2) return;
    if (/^(previous|next|prev|«|»|berikutnya|sebelumnya)\b/i.test(t) && t.length < 40) return;
    paragraphs.push(t);
  });
  const text = paragraphs.length ? paragraphs.join("\n\n") : clean(scope.text());

  const prev = $('a[href*="-chapter-"]').filter((_, a) => /prev/i.test(`${$(a).attr("class") ?? ""} ${clean($(a).text())}`)).first().attr("href");
  const next = $('a[href*="-chapter-"]').filter((_, a) => /next/i.test(`${$(a).attr("class") ?? ""} ${clean($(a).text())}`)).first().attr("href");
  const header = clean($("h1, .post-title h1, .breadcrumb li:last-child").first().text());

  return {
    url: finalUrl || url,
    title: header.replace(/\s+Bahasa Indonesia\s*$/i, "").trim() || null,
    chapter: chapterNumber(header, url),
    paragraphs: paragraphs.length,
    characters: text.length,
    text,
    prev: classify(prev)?.url ?? null,
    next: classify(next)?.url ?? null,
  };
}

export const bacalnEndpoints: Endpoint[] = [
  {
    category: "novel",
    slug: "bacaln-latest",
    kind: "json",
    title: "Novel Terbaru (BacaLN)",
    description:
      "Chapter novel bahasa Indonesia yang baru terbit di bacaln.com, diambil dari daftar pembaruan di beranda. Berisi judul seri, nomor chapter, dan tautan bacanya.",
    params: [
      { name: "limit", description: "Jumlah hasil (1-40, bawaan 20).", example: "10" },
      { name: "page", description: "Halaman beranda bacaln (1-50, bawaan 1).", example: "1" },
    ],
    handler: async ({ sp }) => {
      const limit = Math.floor(num(sp, "limit", 20, 1, 40));
      const p = Math.floor(num(sp, "page", 1, 1, 50));
      const { $, url } = await page(homeUrl(p));
      const items: {
        title: string;
        chapter: number | null;
        slug: string;
        url: string;
        book_slug: string;
        book_title: string;
        book_url: string;
        cover: string | null;
        excerpt: string | null;
      }[] = [];
      const seen = new Set<string>();
      $('a[href*="-chapter-"]').each((_, a) => {
        if (items.length >= limit) return;
        const el = $(a);
        const ref = classify(el.attr("href"));
        if (!ref || ref.kind !== "chapter" || seen.has(ref.slug)) return;
        seen.add(ref.slug);
        const block = blockOf($, el);
        const bookSlug = seriesFromChapterSlug(ref.slug);
        const bookLink = block.find(`a[href*="/series/${bookSlug}/"]`).first();
        const heading = clean(block.find("h1, h2, h3, h4").first().text());
        items.push({
          title: clean(el.text()) && /chapter|ch\.|bab/i.test(clean(el.text())) ? clean(el.text()) : `Ch.${chapterNumber(ref.slug) ?? "?"}`,
          chapter: chapterNumber(clean(el.text()), ref.slug),
          slug: ref.slug,
          url: ref.url,
          book_slug: bookSlug,
          book_title: (clean(bookLink.attr("title")) || heading || titleize(bookSlug)).replace(/\s+Bahasa Indonesia\s*$/i, "").trim(),
          book_url: seriesUrl(bookSlug),
          cover: coverOf($, block),
          excerpt: clean(block.find("p").last().text()).slice(0, 240) || null,
        });
      });
      return { source: url, page: p, total: items.length, items };
    },
  },
  {
    category: "novel",
    slug: "bacaln-search",
    kind: "json",
    title: "Cari Novel (BacaLN)",
    description: "Cari novel bahasa Indonesia di bacaln.com berdasarkan judul. Hasil berisi slug seri untuk endpoint detail dan chapter.",
    params: [
      { name: "q", required: true, description: "Kata kunci judul novel.", example: "alkemis" },
      { name: "page", description: "Nomor halaman hasil (1-50, bawaan 1).", example: "1" },
      { name: "limit", description: "Jumlah hasil maksimal (1-40, bawaan 20).", example: "10" },
    ],
    handler: async ({ sp }) => {
      const q = need(sp, "q", 120);
      const p = Math.floor(num(sp, "page", 1, 1, 50));
      const limit = Math.floor(num(sp, "limit", 20, 1, 40));
      const { $, url } = await page(searchUrl(q, p));
      const items = cards($, limit);
      return {
        source: url,
        query: q,
        page: p,
        total: items.length,
        items,
      };
    },
  },
  {
    category: "novel",
    slug: "bacaln-list",
    kind: "json",
    title: "Jelajahi Novel (BacaLN)",
    description: "Daftar novel bacaln.com per halaman atau per genre. Tanpa parameter genre, isinya pembaruan terbaru di beranda.",
    params: [
      { name: "genre", description: "Slug genre, mis. action, fantasy, romance. Lihat endpoint daftar genre.", example: "fantasy" },
      { name: "page", description: "Nomor halaman (1-50, bawaan 1).", example: "1" },
      { name: "limit", description: "Jumlah hasil maksimal (1-40, bawaan 20).", example: "20" },
    ],
    handler: async ({ sp }) => {
      const genre = opt(sp, "genre").toLowerCase().replace(/\s+/g, "-");
      const p = Math.floor(num(sp, "page", 1, 1, 50));
      const limit = Math.floor(num(sp, "limit", 20, 1, 40));
      if (genre && !/^[a-z0-9-]{2,40}$/.test(genre)) throw new HttpError(400, "Parameter 'genre' tidak valid.");
      const url = genre ? `${BASE}/genre/${encodeURIComponent(genre)}/${p > 1 ? `page/${p}/` : ""}` : homeUrl(p);
      const { $ } = await page(url);
      const items = cards($, limit);
      if (!items.length) throw new HttpError(404, genre ? `Genre '${genre}' tidak punya novel di bacaln.` : "Daftar novel bacaln sedang kosong.");
      return { source: url, page: p, genre: genre || null, total: items.length, items };
    },
  },
  {
    category: "novel",
    slug: "bacaln-genre",
    kind: "json",
    title: "Daftar Genre Novel (BacaLN)",
    description: "Semua genre bacaln.com, diambil dari tautan genre di halaman beranda. Bisa langsung dipakai sebagai parameter genre.",
    params: [],
    handler: async () => {
      const { $ } = await page(BASE);
      const genres: { slug: string; name: string; url: string }[] = [];
      const seen = new Set<string>();
      $('a[href*="/genre/"]').each((_, a) => {
        const href = $(a).attr("href");
        const parts = pathParts(href, BASE);
        const slug = parts[1];
        if (parts[0] !== "genre" || !slug || seen.has(slug)) return;
        seen.add(slug);
        genres.push({ slug, name: clean($(a).text()) || titleize(slug), url: absUrl(href, BASE) ?? `${BASE}/genre/${slug}/` });
      });
      genres.sort((a, b) => a.slug.localeCompare(b.slug));
      return { source: BASE, total: genres.length, genres };
    },
  },
  {
    category: "novel",
    slug: "bacaln-detail",
    kind: "json",
    title: "Detail Novel (BacaLN)",
    description: "Metadata satu novel bacaln.com: judul, status, penulis, artis, tipe, skor, genre, sinopsis, sampul, dan seluruh daftar chapter.",
    params: [{ name: "slug", required: true, description: "Slug seri, URL seri, atau URL chapter bacaln.", example: "alkemis-paling-imut-di-dunia" }],
    handler: async ({ sp }) => {
      const { ref } = target(need(sp, "slug", 400));
      const slug = ref.kind === "chapter" ? seriesFromChapterSlug(ref.slug) : ref.slug;
      const { $, url } = await page(seriesUrl(slug));
      const title = clean($(".post-title h1, h1.entry-title").first().text()) || clean($("h1").first().text());
      const body = $(".post-content, .summary, .manga-summary, article, #manga-page").first();
      const scope = body.length ? body : $.root();
      const chapters = chaptersOf($);
      const latest = chapters.reduce<Chapter | null>((acc, c) => (!acc || (c.chapter ?? 0) > (acc.chapter ?? 0) ? c : acc), null);
      const scoreText = labeled($, scope, ["score", "rating"]);
      const score = scoreText ? Number((scoreText.match(/\d+(?:[.,]\d+)?/)?.[0] ?? "").replace(",", ".")) : null;
      return {
        source: url,
        slug,
        title: title.replace(/\s+Bahasa Indonesia\s*$/i, "").trim() || titleize(slug),
        status: labeled($, scope, ["status"]),
        author: labeled($, scope, ["penulis", "author"]),
        artist: labeled($, scope, ["artis", "artist"]),
        type: labeled($, scope, ["tipe", "type"]),
        score: score !== null && Number.isFinite(score) ? score : null,
        genres: genresOf($, scope),
        synopsis: clean($(".description-summary, .summary__content, .post-content_item .summary-content").first().text()).slice(0, 1200) || null,
        cover: coverOf($, $(".summary_image, .manga__image, .item-thumb, .post-content").first()) ?? coverOf($, $.root()),
        total_chapters: chapters.length,
        first_chapter: chapters[0] ?? null,
        latest_chapter: latest,
        chapters,
      };
    },
  },
  {
    category: "novel",
    slug: "bacaln-chapter",
    kind: "json",
    title: "Baca Chapter Novel (BacaLN)",
    description: "Isi teks satu chapter novel bahasa Indonesia dari bacaln.com, plus navigasi chapter sebelum dan sesudahnya.",
    params: [
      { name: "slug", required: true, description: "Slug seri atau URL chapter bacaln.", example: "alkemis-paling-imut-di-dunia" },
      { name: "chapter", description: "Nomor chapter. Bila kosong dipakai chapter terakhir yang tersedia.", example: "184" },
    ],
    handler: async ({ sp }) => {
      const raw = need(sp, "slug", 400);
      const { ref, chapter } = target(raw);
      const wanted = opt(sp, "chapter") ? Math.floor(num(sp, "chapter", 1, 1, 20000)) : chapter;
      if (ref.kind === "chapter" && !opt(sp, "chapter")) return readChapter(ref.url);
      const slug = ref.kind === "chapter" ? seriesFromChapterSlug(ref.slug) : ref.slug;
      const { $ } = await page(seriesUrl(slug));
      const chapters = chaptersOf($);
      if (!chapters.length) throw new HttpError(404, "Daftar chapter novel itu tidak ditemukan di bacaln.");
      const pick = wanted === null ? chapters[chapters.length - 1] : chapters.find((c) => c.chapter === wanted) ?? null;
      if (!pick) {
        throw new HttpError(
          404,
          `Chapter ${wanted} tidak ada. Tersedia ${chapters[0]?.chapter ?? "?"} sampai ${chapters[chapters.length - 1]?.chapter ?? "?"}.`,
        );
      }
      const book = clean($(".post-title h1, h1.entry-title").first().text()).replace(/\s+Bahasa Indonesia\s*$/i, "").trim() || titleize(slug);
      return { ...(await readChapter(pick.url)), book: { slug, title: book, url: seriesUrl(slug) } };
    },
  },
  {
    category: "novel",
    slug: "bacaln-image",
    kind: "image",
    title: "Proxy Sampul Novel (BacaLN)",
    description: "Teruskan gambar sampul bacaln.com (termasuk CDN WordPress i0-i3.wp.com) supaya bisa ditampilkan tanpa masalah referer.",
    params: [
      {
        name: "url",
        required: true,
        description: "URL gambar https dari bacaln.com atau CDN WordPress-nya.",
        example: "https://i3.wp.com/bacaln.com/wp-content/uploads/2026/08/flip-11710.jpg",
      },
    ],
    handler: async ({ sp }) => {
      let parsed: URL;
      try {
        parsed = new URL(need(sp, "url", 1000));
      } catch {
        throw new HttpError(400, "Parameter 'url' bukan URL yang valid.");
      }
      if (parsed.protocol !== "https:" || !IMAGE_HOSTS.test(parsed.hostname)) {
        throw new HttpError(400, "Hanya URL gambar https dari bacaln.com atau CDN WordPress (i0-i3.wp.com) yang diizinkan.");
      }
      const res = await fetchRaw(
        parsed.toString(),
        { headers: browserHeaders(REFERER, { accept: "image/avif,image/webp,image/*,*/*;q=0.8" }) },
        20000,
      ).catch(() => null);
      if (!res) throw new HttpError(502, "Gagal menghubungi server gambar bacaln.");
      if (!res.ok) throw new HttpError(502, `Server gambar bacaln merespons dengan status ${res.status}.`);
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!type.startsWith("image/")) throw new HttpError(502, "Server sumber tidak mengirim gambar.");
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 4_300_000) throw new HttpError(413, "Gambar terlalu besar untuk diproxy (maks ±4 MB). Gunakan URL aslinya.");
      return binaryResponse(buf, type, "public, max-age=86400, s-maxage=604800, immutable");
    },
  },
];

/** Dipakai uji internal: pastikan kelas CSS tidak diasumsikan. */
export const __bacalnInternals = { classify, chapterNumber, cards, chaptersOf, target };
