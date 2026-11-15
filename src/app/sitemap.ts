import type { MetadataRoute } from "next";
import { categories } from "@/lib/api/categories";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: SITE_URL, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/docs`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_URL}/paket`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    ...categories.map((c) => ({ url: `${SITE_URL}/docs/${c.id}`, lastModified: now, changeFrequency: "weekly" as const, priority: 0.8 })),
  ];
}
