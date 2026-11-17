import { NextResponse } from "next/server";
import { activeBlocks, describeTarget } from "@/lib/blocks";
import { SITE_CREATOR } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * Daftar endpoint yang sedang dinonaktifkan admin. Terbuka tanpa API key; dipakai halaman /docs
 * untuk menandai endpoint yang nonaktif.
 *   path  "/api/film/lk21" untuk satu endpoint, "/api/film/*" untuk satu kategori penuh
 */
export async function GET() {
  const rows = await activeBlocks();
  const blocked = rows.map((b) => {
    const d = describeTarget(b.path);
    return { path: `/api/${b.path}`, scope: d.scope, title: d.title, reason: b.reason, since: b.created_at };
  });
  return NextResponse.json(
    { status: true, creator: SITE_CREATOR, total: blocked.length, blocked },
    { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } },
  );
}
