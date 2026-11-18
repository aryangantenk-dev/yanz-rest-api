import type { Endpoint, EndpointMeta } from "./types";
import { aiEndpoints } from "./ai";
import { toolsEndpoints } from "./tools";
import { textEndpoints } from "./text";
import { imageEndpoints } from "./image";
import { randomEndpoints } from "./random";
import { islamiEndpoints } from "./islami";
import { infoEndpoints } from "./info";
import { komikEndpoints } from "./komik";
import { animeEndpoints } from "./anime";
import { filmEndpoints } from "./film";
import { donghuaEndpoints } from "./donghua";
import { novelEndpoints } from "./novel";
import { canvasEndpoints } from "./canvas";
import { searchEndpoints } from "./search";
import { downloaderEndpoints } from "./downloader";
import { sflEndpoints } from "./sfl";
import { tempMailEndpoints } from "./tempmail";
import { nexaEndpoints } from "./nexa";
import { gamesEndpoints } from "./games";
import { mediaToolEndpoints } from "./mediatools";
import { web2apkEndpoints } from "./web2apk";
import { toUrlEndpoints } from "./tourl";
import { jkt48Endpoints } from "./jkt48";
import { zefameEndpoints } from "./zefame";
import { workerEndpoints } from "./worker";
import { categories } from "./categories";

export const endpoints: Endpoint[] = [
  ...aiEndpoints,
  ...toolsEndpoints,
  ...textEndpoints,
  ...imageEndpoints,
  ...canvasEndpoints,
  ...randomEndpoints,
  ...searchEndpoints,
  ...downloaderEndpoints,
  ...sflEndpoints,
  ...tempMailEndpoints,
  ...nexaEndpoints,
  ...gamesEndpoints,
  ...islamiEndpoints,
  ...infoEndpoints,
  ...komikEndpoints,
  ...animeEndpoints,
  ...filmEndpoints,
  ...donghuaEndpoints,
  ...novelEndpoints,
  ...jkt48Endpoints,
  // Kategorinya beragam; urutan per kategori diatur ulang oleh allMeta().
  ...mediaToolEndpoints,
  ...web2apkEndpoints,
  ...toUrlEndpoints,
  ...zefameEndpoints,
  ...workerEndpoints,
];

// Jalur utama didaftarkan lebih dulu supaya slug kanonik selalu menang atas alias.
const index = new Map<string, Endpoint>();
for (const e of endpoints) {
  const key = `${e.category}/${e.slug}`;
  if (!index.has(key)) index.set(key, e);
}
for (const e of endpoints) {
  for (const alias of e.aliases ?? []) {
    const key = `${e.category}/${alias}`;
    if (!index.has(key)) index.set(key, e);
  }
}

export function findEndpoint(key: string): Endpoint | undefined {
  return index.get(key);
}

export function toMeta(e: Endpoint): EndpointMeta {
  return {
    category: e.category,
    slug: e.slug,
    title: e.title,
    description: e.description,
    params: e.params,
    kind: e.kind,
    ...(e.upload ? { upload: e.upload } : {}),
    path: `/api/${e.category}/${e.slug}`,
  };
}

export function allMeta(): EndpointMeta[] {
  const order = new Map(categories.map((c, i) => [c.id, i]));
  return endpoints.map(toMeta).sort((a, b) => (order.get(a.category)! - order.get(b.category)!));
}
