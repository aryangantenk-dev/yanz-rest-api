import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Alamat di sini mengikuti SITE_URL (NEXT_PUBLIC_SITE_URL): harus alamat yang menjawab 200, bukan yang dialihkan.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/docs", "/api"], disallow: ["/api/stats", "/api/status", "/api/auth/", "/s/", "/avatar/", "/akun", "/dashboard", "/admin", "/chat", "/api/admin/", "/api/paket/", "/api/chat/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
