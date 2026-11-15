import { NextResponse } from "next/server";
import { WORKER_FILE_RE, workerBase } from "@/lib/api/worker";
import { SITE_CREATOR } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * Tautan berkas hasil endpoint worker (mp3, gif, mp4, pdf, ...): /w/<nama acak>.
 * Berkasnya ada di mesin worker; rute ini hanya mengalihkan ke sana, supaya tautan yang dibagikan
 * tetap memakai domain ini dan lalu lintas berkas besar tidak lewat Vercel.
 */
export async function GET(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const base = workerBase();
  if (!WORKER_FILE_RE.test(name) || !base) {
    return NextResponse.json({ status: false, code: 404, creator: SITE_CREATOR, error: "Berkas tidak ditemukan atau sudah dihapus." }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const download = new URL(req.url).searchParams.get("download") === "1" ? "?download=1" : "";
  return new Response(null, { status: 302, headers: { location: `${base}/f/${name}${download}`, "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
