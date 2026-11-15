import { KEY_REQUIRED } from "@/lib/auth/config";
import { BRAND_NAME } from "@/lib/brand";

/** Nama merek. Identitas merek lainnya (domain, nama lain, teks logo) ada di src/lib/brand.ts. */
export const SITE_NAME = BRAND_NAME;
/** Nilai field `creator` pada setiap respons JSON. */
export const SITE_CREATOR = "yanz.api";
/** Kalimat pendek pembeda: berubah begitu API key diwajibkan (login aktif). */
/** Halaman dukungan (SociaBuzz Tribe) milik pemilik situs. */
export const SUPPORT_URL = "https://sociabuzz.com/vibeyan/tribe";
/** Saluran WhatsApp resmi: pengumuman endpoint baru, gangguan, dan pembaruan. */
export const WHATSAPP_CHANNEL_URL = "https://whatsapp.com/channel/0029VbDtQ7R89inbCHWpTr16";
export const WHATSAPP_CHANNEL_NAME = "Saluran WhatsApp yanz.api";
export const SITE_PITCH = KEY_REQUIRED ? "gratis dengan API key" : "gratis tanpa API key";
export const SITE_TAGLINE = KEY_REQUIRED ? "REST API Gratis untuk Developer Indonesia" : "REST API Gratis Tanpa API Key";

const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "";

/** Atur NEXT_PUBLIC_SITE_URL ke domain produksi agar canonical, sitemap, dan OG benar. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || vercelUrl || "http://localhost:3000").replace(/\/$/, "");

export function getOrigin(req: Request): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host");
  if (host) return `${proto || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")}://${host}`;
  return SITE_URL;
}
