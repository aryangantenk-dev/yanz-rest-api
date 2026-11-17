import type { Metadata } from "next";
import { endpoints } from "@/lib/api/registry";
import { KEY_REQUIRED } from "@/lib/auth/config";
import { BRAND_ALTERNATE_NAMES, BRAND_DOMAIN, BRAND_FEATURES, BRAND_KEYPHRASE, BRAND_LOGO_ALT } from "@/lib/brand";
import { SITE_NAME, SITE_PITCH, SITE_TAGLINE, SITE_URL, WHATSAPP_CHANNEL_URL } from "@/lib/site";

/*
  Judul, deskripsi, Open Graph, dan data terstruktur. Tiga kata kunci merek selalu ikut:
  nama (yanz.api), domain (yanzapi.my.id), dan frasa "REST API Gratis Indonesia".
  Jumlah endpoint dihitung dari daftar endpoint, jadi tidak perlu diubah tangan saat bertambah.
*/

export const ENDPOINT_COUNT = endpoints.length;

/** "165 Endpoint REST API Gratis untuk Developer Indonesia" */
export const SEO_TAGLINE = `${ENDPOINT_COUNT} Endpoint ${SITE_TAGLINE}`;

const featureText = `${BRAND_FEATURES.slice(0, -1).join(", ")}, dan ${BRAND_FEATURES[BRAND_FEATURES.length - 1]}`;

/** <title> beranda. */
export const HOME_TITLE = `${SITE_NAME} — ${ENDPOINT_COUNT} Endpoint ${BRAND_KEYPHRASE} | ${BRAND_DOMAIN}`;
/** Judul untuk kartu tautan (Open Graph, Twitter): nama merek dan tagline. */
export const HOME_SHARE_TITLE = `${SITE_NAME} — ${SEO_TAGLINE}`;
export const HOME_DESCRIPTION = `${SITE_NAME} (${BRAND_DOMAIN}): ${BRAND_KEYPHRASE} dengan ${ENDPOINT_COUNT} endpoint untuk ${featureText}. ${KEY_REQUIRED ? "Daftar gratis dan langsung dapat API key." : "Tanpa API key dan tanpa daftar."}`;

/** Uraian panjang layanan, untuk data terstruktur. */
export const APP_DESCRIPTION = `${SITE_NAME} adalah REST API ${SITE_PITCH} dengan ${ENDPOINT_COUNT} endpoint: AI chat, text to image, canvas (brat, iqc), downloader TikTok/Instagram/Facebook, pencarian Pinterest, game untuk bot WhatsApp, cuaca, gempa BMKG, Al-Qur'an, jadwal sholat, scraper komik & anime, film & serial (TMDB + player embed), data JKT48, dan banyak lagi. ${KEY_REQUIRED ? "Masuk dengan Google atau email untuk mendapat API key gratis. " : ""}Dokumentasi lengkap dengan playground interaktif.`;

export const DOCS_TITLE = `Dokumentasi ${SITE_NAME} — ${BRAND_KEYPHRASE} | ${BRAND_DOMAIN}`;
export const DOCS_DESCRIPTION = `Dokumentasi ${SITE_NAME} (${BRAND_DOMAIN}), ${BRAND_KEYPHRASE}: ${ENDPOINT_COUNT} endpoint ${featureText}. Coba langsung di browser dan salin contoh cURL, JavaScript, Python, PHP.`;

export const KEYWORDS = [
  SITE_NAME,
  "yanz api",
  ...BRAND_ALTERNATE_NAMES,
  BRAND_KEYPHRASE.toLowerCase(),
  "rest api gratis",
  "free rest api indonesia",
  "api developer indonesia",
  ...(KEY_REQUIRED ? ["api key gratis"] : ["api tanpa apikey", "no api key"]),
  "api downloader",
  "api ai chat gratis",
  "api canvas",
  "api cuaca",
  "api gempa bmkg",
  "api jadwal sholat",
  "api al-quran",
  "api komik",
  "api anime",
  "api film",
  "api jkt48",
  "api bot whatsapp",
];

/** Gambar pratinjau tautan (1200 x 630) dari src/app/opengraph-image.tsx, beserta teks penggantinya. */
export const SHARE_IMAGE_ALT = `${SITE_NAME} — ${SEO_TAGLINE} (${BRAND_DOMAIN})`;
const SHARE_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, type: "image/png", alt: SHARE_IMAGE_ALT };

/**
 * Metadata satu halaman: judul, deskripsi, canonical, Open Graph, dan Twitter Card.
 *
 * Next.js tidak menggabungkan `openGraph` dan `twitter` milik halaman dengan milik layout; yang di
 * halaman menggantikan seluruhnya, termasuk gambar dari src/app/opengraph-image.tsx. Karena itu semuanya
 * ditulis lengkap di sini, supaya og:site_name, og:url, og:title, og:description, dan gambar pratinjau
 * selalu ada dan selalu milik halaman itu sendiri.
 */
export function pageMeta({
  title,
  absolute = false,
  shareTitle,
  description,
  path,
}: {
  title: string;
  /** Judul dipakai apa adanya, tanpa akhiran " | yanz.api". */
  absolute?: boolean;
  /** Judul di kartu tautan bila berbeda dari <title>. */
  shareTitle?: string;
  description: string;
  /** Alamat halaman di situs ini, mis. "/docs". */
  path: string;
}): Metadata {
  const full = absolute ? title : `${title} | ${SITE_NAME}`;
  const share = shareTitle ?? full;
  return {
    title: absolute ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", locale: "id_ID", siteName: SITE_NAME, url: path, title: share, description, images: [SHARE_IMAGE] },
    twitter: { card: "summary_large_image", title: share, description, images: [SHARE_IMAGE] },
  };
}

/** Logo sebagai berkas gambar (512 px), untuk data terstruktur. Lihat src/app/logo.png/route.tsx. */
export const LOGO_URL = `${SITE_URL}/logo.png`;

/**
 * Data terstruktur situs, dipasang di <head> semua halaman: WebSite (nama situs di hasil pencarian),
 * Organization (logo), dan SoftwareApplication (layanan API-nya). Ketiganya membawa `alternateName`
 * yang sama, supaya pencarian "yanzapi", "yanzapi.my.id", atau "Yanz API Indonesia" mengarah ke satu merek.
 */
export function siteJsonLd() {
  const org = { "@id": `${SITE_URL}/#org` };
  const logo = { "@type": "ImageObject", url: LOGO_URL, width: 512, height: 512, caption: BRAND_LOGO_ALT };
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: `${SITE_URL}/`,
        name: SITE_NAME,
        alternateName: BRAND_ALTERNATE_NAMES,
        description: HOME_DESCRIPTION,
        inLanguage: "id-ID",
        publisher: org,
      },
      {
        "@type": "Organization",
        "@id": org["@id"],
        name: SITE_NAME,
        alternateName: BRAND_ALTERNATE_NAMES,
        url: `${SITE_URL}/`,
        logo,
        image: logo,
        sameAs: [WHATSAPP_CHANNEL_URL],
        // Profil merek untuk mesin pencari (logo di panel pengetahuan Google).
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          url: WHATSAPP_CHANNEL_URL,
          availableLanguage: ["id"],
        },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#app`,
        name: SITE_NAME,
        alternateName: BRAND_ALTERNATE_NAMES,
        url: `${SITE_URL}/`,
        description: APP_DESCRIPTION,
        disambiguatingDescription: `${SITE_NAME} adalah layanan REST API gratis untuk developer Indonesia dengan alamat resmi ${BRAND_DOMAIN}.`,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "REST API",
        operatingSystem: "Any",
        inLanguage: "id-ID",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "IDR" },
        featureList: BRAND_FEATURES,
        image: logo,
        softwareHelp: { "@type": "CreativeWork", name: `Dokumentasi ${SITE_NAME}`, url: `${SITE_URL}/docs` },
        publisher: org,
      },
      {
        // Penawaran paket: membantu mesin pencari menampilkan rentang harga di cuplikan.
        "@type": "Service",
        "@id": `${SITE_URL}/paket#service`,
        name: `${SITE_NAME} — paket harian`,
        provider: org,
        serviceType: "REST API",
        areaServed: "ID",
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "IDR",
          lowPrice: "0",
          highPrice: "5000",
          offerCount: 4,
          url: `${SITE_URL}/paket`,
        },
      },
    ],
  };
}

/** JSON untuk <script type="application/ld+json">; "<" ditulis sebagai kode supaya tidak bisa menutup tag script. */
export const jsonLdText = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
