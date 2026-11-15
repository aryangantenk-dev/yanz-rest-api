import { NextResponse } from "next/server";
import { allMeta } from "@/lib/api/registry";
import { categories } from "@/lib/api/categories";
import { KEY_REQUIRED } from "@/lib/auth/config";
import { SITE_CREATOR, SITE_NAME, getOrigin } from "@/lib/site";
import { activeBlocks } from "@/lib/blocks";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const origin = getOrigin(req);
  const list = allMeta();
  // Endpoint yang sedang dinonaktifkan admin ditandai `blocked: true`.
  const blocks = new Set((await activeBlocks()).map((b) => b.path));
  const blocked = (e: { category: string; slug: string }) => blocks.has(`${e.category}/${e.slug}`) || blocks.has(`${e.category}/*`);
  return new NextResponse(
    JSON.stringify(
      {
        status: true,
        name: SITE_NAME,
        creator: SITE_CREATOR,
        baseUrl: `${origin}/api`,
        docs: `${origin}/docs`,
        apiKey: KEY_REQUIRED ? "required" : "not required",
        ...(KEY_REQUIRED
          ? { auth: { login: `${origin}/login`, how: "Tambahkan parameter apikey=yn-... ke setiap permintaan, atau kirim header x-api-key." } }
          : {}),
        totalEndpoints: list.length,
        ...(blocks.size ? { blockedEndpoints: list.filter(blocked).length, statusUrl: `${origin}/api/status` } : {}),
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          endpoints: list.filter((e) => e.category === c.id).map((e) => ({ path: e.path, title: e.title, params: e.params.map((p) => p.name), ...(blocked(e) ? { blocked: true } : {}) })),
        })),
      },
      null,
      2,
    ),
    { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } },
  );
}
