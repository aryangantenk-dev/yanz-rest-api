import { load, type CheerioAPI } from "cheerio";
import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { binaryResponse, fetchRaw, need, num, opt } from "./helpers";
import { absUrl, browserHeaders, clean, cleanSlug, fetchPage, imgSrc, pathParts, type El, type Page } from "./scrape";

/*
  Sumber: https://bacaln.com (WordPress, tema Madara — novel bahasa Indonesia).
  Pola halaman sama seperti situs Madara pada umumnya:
  - beranda & pencarian: kartu di .page-item-detail / .c-tabs-item__content
  - seri: /series/<slug>/ berisi info + daftar chapter di .wp-manga-chapter
  - chapter: /<slug>-chapter-<n>/ berisi teks di .reading-content
  Alamat chapter TIDAK memakai /series/, melainkan langsung di akar domain.

  RSS beranda dipakai untuk "terbaru" karena halaman beranda memuat 10 kartu per halaman
  sedangkan RSS membawa 20 chapter terakhir tanpa perlu menebak markup kartu.
*/
const BASE = "https://bacaln.com";
const REFERER = `${BASE}/`;
const RSS = `${BASE}/feed/`;
const IMAGE_HOSTS = /(^|\.)(bacaln\.com|wp\.com)$/i;
/** Path yang bukan seri maupun chapter, supaya link menu tidak salah tebak. */
const RESERVED = new Set([
  "series", "genre", "manga", "novel", "page", "cari-novel", "feed", "wp-json", "wp-admin", "wp-content",
  "wp-login.php", "wp-includes", "tag", "author", "bookmark", "s", "search", "category", "light-novel",
  "web-novel", "novel-china", "novel-korea", "daftar-novel", "semua-novel", "advanced-search", "sitemap.xml",
]);

const seriesUrl = (slug: string) => `${BASE}/series/${encodeURIComponent(slug)}/`;
const searchUrl = (q: string, page: number) => `${BASE}/?s=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ""}`;
const pageUrl = (page: number) => (page > 1 ? `${BASE}/page/${page}/` : `${BASE}/`);

type Ref = { kind: "series" | "chapter"; slug: string; url: string };

/** Kenali tautan seri (/series/<slug>) dan chapter (/<slug>-chapter-<n>). */
function classify(href: string | null | undefined): Ref | null {
  if (!href) return null;
  try {
    if (new URL(href, BASE).hostname !== new URL(BASE).hostname) return null;
  } catch {
    return null;
  }
  const parts = pathParts(href, BASE);
  if (!parts.length) return null;
  if (parts[0] === "series" && parts[1]) return { kind: "series", slug: parts[1], url: seriesUrl(parts[1]) };
  if (parts.length === 1 && !RESERVED.has(parts[0]) && /-chapter-\d+$/i.test(parts[0])) {
    return { kind: "chapter", slug: parts[0], url: `${BASE}/${encodeURIComponent(parts[0])}/` };
  }
  return null;
}

/** Nomor chapter dari teks ("Ch.184", "Bab 184") atau dari slug chapter. */
function chapterNumber(...values: (string | null | undefined)[]): number | null {
  for (const v of values) {
    const m = clean(v).match(/(?:chapter|ch\.?|bab)\s*[-_ ]?\s*(\d+(?:\.\d+)?)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Judul seri dari slug chapter: buang akhiran "-chapter-<n>". */
function titleFromChapterSlug(slug: string): string {
  return slug.replace(/-chapter-\d+$/i, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type Card = {
  title: string;
  slug: string;
  url: string;
  poster: string | null;
  latest_chapter: number | null;
  latest_chapter_url: string | null;
  updated_at: string | null;
  genres: string[];
  type: string | null;
  status: string | null;
  author: string | null;
  synopsis: string | null;
};

function posterOf($: CheerioAPI, el: El): string | null {
  const img = el.find("img").first();
  return imgSrc(img, BASE) ?? absUrl(img.attr("data-cfsrc") ?? null, BASE);
}

/** Kartu seri di beranda/pencarian/genre (Madara: .page-item-detail atau .c-tabs-item__content). */
function cardFrom($: CheerioAPI, el: El): Card | null {
  const link = el.find('a[href*="/series/"]').first();
  const ref = classify(link.attr("href"));
  if (!ref || ref.kind !== "series") return null;
  const title =
    clean(el.find(".post-title h3, .post-title h4, h3.h4, .h4 a, .post-title").first().text()) ||
    clean(link.attr("title")) ||
    titleFromChapterSlug(ref.slug);
  const genres: string[] = [];
  el.find('a[href*="/genre/"]').each((_, g) => {
    const name = clean($(g).text());
    if (name && !genres.includes(name)) genres.push(name);
  });
  const chapterHref = el.find('a[href*="-chapter-"]').first().attr("href");
  return {
    title,
    slug: ref.slug,
    url: ref.url,
    poster: posterOf($, el),
    latest_chapter: chapterNumber(el.find(".chapter-item .chapter a, a[href*=\"-chapter-\"]").first().text(), chapterHref),
    latest_chapter_url: absUrl(chapterHref ?? null, BASE),
    updated_at: clean(el.find(".post-on, .chapter-item .post-on").first().text()) || null,
    genres,
    type: clean(el.find(".mg_genre, .manga-type").first().text()) || null,
    status: clean(el.find(".mg_status").first().text()) || null,
    author: clean(el.find(".mg_author, .author-content").first().text()) || null,
    synopsis: clean(el.find(".post-content_item ~ .post-content, .description-summary").first().text()) || null,
  };
}

function cards($: CheerioAPI): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  $(".page-item-detail, .c-tabs-item__content, .manga__item").each((_, node) => {
    const c = cardFrom($, $(node));
    if (!c || seen.has(c.slug)) return;
    seen.add(c.slug);
    out.push(c);
  });
  return out;
}

/** Metadata kecil di halaman seri: daftar "Judul / Status / Penulis / Genre / Score". */
type Info = { title: string | null; status: string | null; author: string | null; artist: string | null; type: string | null; score: number | null; genres: string[] };

function seriesInfo($: CheerioAPI): Info {
  const genres: string[] = [];
  $('.genres-content a[href*="/genre/"], .wp-manga-tags-list a[href*="/genre/"]').each((_, a) => {
    const name = clean($(a).text());
    if (name && !genres.includes(name)) genres.push(name);
  });
  const field = (labels: string[]): string | null => {
    let found: string | null = null;
    $(".post-content_item").each((_, node) => {
      if (found) return;
      const heading = clean($(node).find(".summary-heading").text()).replace(/:$/, "").toLowerCase();
      if (labels.some((l) => heading.includes(l))) found = clean($(node).find(".summary-content").text()) || null;
    });
    return found;
  };
  const rawTitle = clean($(".post-title h1, h1.entry-title").first().text());
  const score = clean($(".score, .post-total-rating .score").first().text()).match(/\d+(?:\.\d+)?/);
  return {
    title: rawTitle.replace(/\s+Bahasa Indonesia\s*$/i, "").trim() || null,
    status: field(["status"]),
    author: field(["penulis", "author"]),
    artist: field(["artis", "artist"]),
    type: field(["tipe", "type"]),
    score: score ? Number(score[0]) : null,
    genres,
  };
}

type Chapter = { chapter: number | null; title: string; name: string; slug: string; url: string; date: string | null };

/** Daftar chapter di halaman seri (.wp-manga-chapter). */
function chaptersOf($: CheerioAPI): Chapter[] {
  const out: Chapter[] = [];
  const seen = new Set<string>();
  $(".wp-manga-chapter a, li.wp-manga-chapter a, .listing-chapters_wrap a").each((_, a) => {
    const href = $(a).attr("href");
    const ref = classify(href);
    if (!ref || ref.kind !== "chapter" || seen.has(ref.slug)) return;
    seen.add(ref.slug);
    const label = clean($(a).text());
    const n = chapterNumber(label, ref.slug);
    out.push({
      chapter: n,
      title: label || (n === null ? ref.slug : `Ch.${n}`),
      name: titleFromChapterSlug(ref.slug),
      slug: ref.slug,
      url: ref.url,
      date: clean($(a).closest("li").find(".chapter-release-date, .post-on").first().text()) || null,
    });
  });
  // Tampilkan urut naik supaya konsisten dengan scraper lain di repo ini.
  return out.sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0));
}

/** Terima slug polos, URL seri, atau URL chapter bacaln. */
function target(raw: string): { ref: Ref; chapter: number | null } {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    const ref = classify(v);
    if (!ref) throw new HttpError(400, "URL bacaln tidak dikenali. Kirim URL /series/<slug>/ atau /<slug>-chapter-<n>/.");
    return { ref, chapter: ref.kind === "chapter" ? chapterNumber(ref.slug) : null };
  }
  const slug = cleanSlug(v.replace(/^\/?(series\/)?/i, ""), "slug");
  const ref = classify(`/${slug}/`);
  if (ref) return { ref, chapter: ref.kind === "chapter" ? chapterNumber(slug) : null };
  // Slug seri tanpa awalan /series/ (mis. "alkemis-paling-imut-di-dunia").
  return { ref: { kind: "series", slug, url: seriesUrl(slug) }, chapter: null };
}

/** Beranda/pencarian bisa 404 bila situs mengalihkan; ubah jadi galat yang jelas. */
async function page(url: string): Promise<Page> {
  try {
    return await fetchPage(url, REFERER);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(404, "Halaman bacaln tidak ditemukan.");
    throw new HttpError(502, "Situs bacaln tidak bisa dihubungi. Coba lagi beberapa saat lagi.");
  }
}

/** Isi satu chapter: teks paragraf di .reading-content. */
async function readChapter(url: string) {
  const { $ } = await page(url);
  const body = $(".reading-content").first();
  if (!body.length) throw new HttpError(502, "Halaman chapter bacaln tidak memuat teks bacaan.");
  // Buang judul/iklan yang ikut terbawa di dalam kontainer bacaan.
  body.find("script, style, .code-block, .ads, .ad, ins, iframe").remove();
  const paragraphs: string[] = [];
  body.find("p").each((_, p) => {
    const t = clean($(p).text());
    if (t) paragraphs.push(t);
  });
  const text = (paragraphs.length ? paragraphs.join("\n\n") : clean(body.text()));
  const prev = $('a[href*="chapter"]:contains("Previous"), a.btn-prev, a[rel="prev"]').first().attr("href");
  const next = $('a[href*="chapter"]:contains("Next"), a.btn-next, a[rel="next"]').first().attr("href");
  const label = clean($(".breadcrumb li:last-child, .post-title h1, h1.entry-title").first().text());
  return {
    title: label.replace(/\s+Bahasa Indonesia\s*$/i, "").trim() || null,
    chapter: chapterNumber(label, url),
    paragraphs: paragraphs.length,
    text,
    characters: text.length,
    prev: classify(prev)?.url ?? null,
    next: classify(next)?.url ?? null,
    url,
  };
}

export const bacalnEndpoints: Endpoint[] = [
  {
    category: "novel",
    slug: "bacaln-latest",
    kind: "json",
    title: "Novel Terbaru",
    description:
      "Chapter novel bahasa Indonesia yang baru diperbarui di bacaln.com, lengkap dengan judul seri, nomor chapter, tanggal, genre, dan tautan baca.",
    params: [{ name: "limit", description: "Jumlah hasil (1-20, bawaan 20).", example: "10" }],
    handler: async ({ sp }) => {
      const limit = Math.floor(num(sp, "limit", 20, 1, 20));
      const res = await fetchRaw(RSS, { headers: browserHeaders(REFERER, { accept: "application/rss+xml, application/xml, text/xml, */*" }) }, 15000).catch(() => {
        throw new HttpError(502, "Umpan terbaru bacaln tidak bisa diambil.");
      });
      const $ = load(await res.text(), { xmlMode: true });
      const items: {
        title: string;
        chapter: number | null;
        slug: string | null;
        url: string | null;
        book_slug: string | null;
        published_at: string | null;
        categories: string[];
        excerpt: string;
      }[] = [];
      $("item").each((_, node) => {
        if (items.length >= limit) return;
        const el = $(node);
        const link = clean(el.find("link").first().text());
        const ref = classify(link);
        const cats: string[] = [];
        el.find("category").each((_, c) => {
          const name = clean($(c).text());
          if (name && !cats.includes(name)) cats.push(name);
        });
        items.push({
          title: clean(el.find("title").first().text()),
          chapter: chapterNumber(clean(el.find("title").first().text()), ref?.slug),
          slug: ref?.slug ?? null,
          url: ref?.url ?? (link || null),
          book_slug: ref?.kind === "chapter" ? ref.slug.replace(/-chapter-\d+$/i, "") : null,
          published_at: clean(el.find("pubDate").first().text()) || null,
          categories: cats,
          excerpt: clean(el.find("description").first().text()).slice(0, 220) || "",
        });
      });
      return { source: BASE, total: items.length, items };
    },
  },
  {
    category: "novel",
    slug: "bacaln-search",
    kind: "json",
    title: "Cari Novel",
    description: "Cari novel bahasa Indonesia di bacaln.com berdasarkan judul. Hasil berisi slug seri untuk endpoint detail dan chapter.",
    params: [
      { name: "q", required: true, description: "Kata kunci judul novel.", example: "alkemis" },
      { name: "page", description: "Nomor halaman (1-50, bawaan 1).", example: "1" },
    ],
    handler: async ({ sp }) => {
      const q = need(sp, "q", 120);
      const p = Math.floor(num(sp, "page", 1, 1, 50));
      const { $ } = await page(searchUrl(q, p));
      const items = cards($);
      return {
        source: BASE,
        query: q,
        page: p,
        has_next: $(".pagination a, a.next, .page-numbers a").filter((_, a) => /page\/\d+|\?s=.*page=\d+/i.test($(a).attr("href") ?? "")).length > 0,
        total: items.length,
        items,
      };
    },
  },
  {
    category: "novel",
    slug: "bacaln-list",
    kind: "json",
    title: "Jelajahi Novel",
    description: "Daftar novel bacaln.com per halaman atau per genre. Isi 20 novel terbaru di halaman tanpa filter genre.",
    params: [
      { name: "genre", description: "Slug genre, mis. action, fantasy, romance. Lihat endpoint daftar genre.", example: "fantasy" },
      { name: "page", description: "Nomor halaman (1-50, bawaan 1).", example: "1" },
    ],
    handler: async ({ sp }) => {
      const genre = opt(sp, "genre").toLowerCase().replace(/\s+/g, "-");
      const p = Math.floor(num(sp, "page", 1, 1, 50));
      if (genre && !/^[a-z0-9-]{2,40}$/.test(genre)) throw new HttpError(400, "Parameter 'genre' tidak valid.");
      const url = genre ? `${BASE}/genre/${encodeURIComponent(genre)}/${p > 1 ? `page/${p}/` : ""}` : pageUrl(p);
      const { $ } = await page(url);
      const items = cards($);
      return { source: BASE, page: p, genre: genre || null, url, total: items.length, items };
    },
  },
  {
    category: "novel",
    slug: "bacaln-genre",
    kind: "json",
    title: "Daftar Genre Novel",
    description: "Genre yang dipakai bacaln.com, diambil dari tautan genre di halaman beranda. Bisa langsung dipakai sebagai parameter genre.",
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
        genres.push({ slug, name: clean($(a).text()) || slug, url: absUrl(href, BASE) ?? `${BASE}/genre/${slug}/` });
      });
      return { source: BASE, total: genres.length, genres };
    },
  },
  {
    category: "novel",
    slug: "bacaln-detail",
    kind: "json",
    title: "Detail Novel",
    description: "Metadata satu novel bacaln.com: judul, status, penulis, artis, tipe, skor, genre, sinopsis, sampul, dan seluruh daftar chapter.",
    params: [{ name: "slug", required: true, description: "Slug seri, URL seri, atau URL chapter bacaln.", example: "alkemis-paling-imut-di-dunia" }],
    handler: async ({ sp }) => {
      const { ref } = target(need(sp, "slug", 400));
      const slug = ref.kind === "chapter" ? ref.slug.replace(/-chapter-\d+$/i, "") : ref.slug;
      const { $, url } = await page(seriesUrl(slug));
      const info = seriesInfo($);
      const chapters = chaptersOf($);
      const latest = chapters.reduce<Chapter | null>((acc, c) => (!acc || (c.chapter ?? 0) > (acc.chapter ?? 0) ? c : acc), null);
      return {
        source: url,
        slug,
        title: info.title,
        status: info.status,
        author: info.author,
        artist: info.artist,
        type: info.type,
        score: info.score,
        genres: info.genres,
        synopsis: clean($(".description-summary, .summary__content").first().text()) || null,
        cover: posterOf($, $(".summary_image, .manga__image, .item-thumb").first()),
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
    title: "Baca Chapter Novel",
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
      const slug = ref.kind === "chapter" ? ref.slug.replace(/-chapter-\d+$/i, "") : ref.slug;
      const { $ } = await page(seriesUrl(slug));
      const chapters = chaptersOf($);
      if (!chapters.length) throw new HttpError(404, "Daftar chapter novel itu tidak ditemukan di bacaln.");
      const pick = wanted === null ? chapters[chapters.length - 1] : chapters.find((c) => c.chapter === wanted) ?? null;
      if (!pick) throw new HttpError(404, `Chapter ${wanted} tidak ada. Tersedia ${chapters[0]?.chapter ?? "?"} sampai ${chapters[chapters.length - 1]?.chapter ?? "?"}.`);
      return { ...(await readChapter(pick.url)), book: { slug, title: seriesInfo($).title, url: seriesUrl(slug) } };
    },
  },
  {
    category: "novel",
    slug: "bacaln-image",
    kind: "image",
    title: "Proxy Sampul Novel",
    description: "Teruskan gambar sampul bacaln.com (termasuk gambar dari CDN WordPress) supaya bisa ditampilkan tanpa masalah referer.",
    params: [{ name: "url", required: true, description: "URL gambar https dari bacaln.com atau CDN-nya.", example: "https://i3.wp.com/bacaln.com/wp-content/uploads/2022/03/image-placeholder.png" }],
    handler: async ({ sp }) => {
      const parsed = (() => {
        try {
          return new URL(need(sp, "url", 1000));
        } catch {
          throw new HttpError(400, "Parameter 'url' bukan URL yang valid.");
        }
      })();
      if (parsed.protocol !== "https:" || !IMAGE_HOSTS.test(parsed.hostname)) {
        throw new HttpError(400, "Hanya URL gambar https dari bacaln.com atau CDN WordPress yang diizinkan.");
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
