/**
 * Identitas merek. Hanya teks tetap (tanpa variabel lingkungan), jadi aman di-import dari
 * komponen server maupun "use client". Dipakai untuk judul halaman, Open Graph, JSON-LD, dan teks logo,
 * supaya nama merek tertulis sama persis di semua tempat.
 */
export const BRAND_NAME = "yanz.api";
/** Domain sebagai kata kunci merek (tanpa protokol dan tanpa www). Alamat lengkap situs ada di SITE_URL. */
export const BRAND_DOMAIN = "yanzapi.my.id";
export const BRAND_KEYPHRASE = "REST API Gratis Indonesia";
/** Nama lain yang dipakai orang untuk mencari situs ini; ditulis di `alternateName` pada JSON-LD. */
export const BRAND_ALTERNATE_NAMES = ["yanzapi", "yanzapi.my.id", "Yanz API Indonesia"];
/** Teks pengganti logo. */
export const BRAND_LOGO_ALT = `${BRAND_NAME} - ${BRAND_KEYPHRASE} ${BRAND_DOMAIN}`;
/** Fitur utama, dalam urutan yang sama di judul, deskripsi, dan data terstruktur. */
export const BRAND_FEATURES = ["AI", "Downloader", "Canvas", "Search", "Data BMKG", "Al-Qur'an", "Komik", "Anime", "Film", "JKT48"];
