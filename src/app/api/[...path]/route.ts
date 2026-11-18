import { NextResponse } from "next/server";
import { findEndpoint } from "@/lib/api/registry";
import { HttpError } from "@/lib/api/types";
import { SITE_CREATOR, getOrigin } from "@/lib/site";
import { recordHit } from "@/lib/stats";
import { APPEAL_URL, OWNER_WA, RATE_LIMIT, clientIp, guard, ipBusy } from "@/lib/guard";
import { KEY_REQUIRED } from "@/lib/auth/config";
import { keyBlock, keyFromRequest, keyKnown, keyOwnerId, keyPaid, keyQuota, keyRefundExtra, keyUse, verifyKey, withKeyInHtml, withKeyInLinks } from "@/lib/auth/apikey";
import { formatNumber } from "@/lib/plans";
import { recordUsage } from "@/lib/auth/usage";
import { endpointBlock } from "@/lib/blocks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Sebagian besar endpoint selesai dalam beberapa detik; batas ini dibuat longgar untuk build APK (tools/web2apk).
export const maxDuration = 120;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};

function fail(status: number, error: string, extra: Record<string, string> = {}, more: Record<string, unknown> = {}) {
  return NextResponse.json({ status: false, code: status, creator: SITE_CREATOR, error, ...more }, { status, headers: { ...CORS, ...extra } });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

type RouteCtx = { params: Promise<{ path: string[] }> };

export function GET(req: Request, ctx: RouteCtx) {
  return handle(req, ctx);
}

/** POST hanya untuk endpoint yang menerima unggahan berkas (lihat `upload` di definisi endpoint). */
export function POST(req: Request, ctx: RouteCtx) {
  return handle(req, ctx);
}

async function handle(req: Request, ctx: RouteCtx) {
  const { path } = await ctx.params;
  const key = path.join("/").toLowerCase();
  const endpoint = findEndpoint(key);
  if (!endpoint) {
    return fail(404, `Endpoint '/api/${key}' tidak ditemukan. Lihat daftar lengkap di /docs atau GET /api.`);
  }
  if (req.method === "POST" && !endpoint.upload) {
    return fail(405, `Endpoint '/api/${key}' hanya menerima GET.`, { allow: "GET, OPTIONS" });
  }

  const ip = clientIp(req);
  const origin = getOrigin(req);
  const sp = new URL(req.url).searchParams;
  const apiKey = keyFromRequest(req, sp);
  sp.delete("apikey");
  sp.delete("api_key");

  // Akun paket berbayar dihitung per akun dengan batas paketnya; selain itu per IP.
  // Paketnya dibaca dari cache. Key yang belum dikenal di instance ini baru diperiksa lebih awal
  // bila IP-nya sudah mencapai batas: hanya saat itulah paketnya mengubah hasil, dan dengan begitu
  // tebak-tebakan key tetap terkena batas per IP tanpa satu panggilan database per tebakan.
  let paid = KEY_REQUIRED ? keyPaid(apiKey) : null;
  if (KEY_REQUIRED && !paid && apiKey && !keyKnown(apiKey) && ipBusy(ip)) {
    await verifyKey(apiKey);
    paid = keyPaid(apiKey);
  }
  const verdict = await guard(ip, paid);
  let rlHeaders = verdict.headers;
  if (verdict.kind === "banned") {
    return fail(
      403,
      `IP kamu (${ip}) diblokir karena melanggar batas ${RATE_LIMIT} permintaan per menit. Untuk banding, hubungi owner lewat WhatsApp ${OWNER_WA}.`,
      rlHeaders,
      { banned: true, ip, reason: verdict.reason, appeal: APPEAL_URL },
    );
  }
  if (verdict.kind === "limited") {
    if (paid) {
      return fail(429, `Terlalu banyak permintaan: batas ${paid.name === "Admin" ? "akun admin" : `paket ${paid.name}`} adalah ${formatNumber(paid.limit)} per menit. Coba lagi dalam ${verdict.retryAfter} detik.`, rlHeaders, {
        limit: paid.limit,
        retry_after: verdict.retryAfter,
      });
    }
    return fail(
      429,
      `Terlalu banyak permintaan: batasnya ${RATE_LIMIT} per menit per IP. Coba lagi dalam ${verdict.retryAfter} detik. Pelanggaran berulang membuat IP diblokir.`,
      rlHeaders,
      { limit: RATE_LIMIT, retry_after: verdict.retryAfter, strikes: verdict.strikes },
    );
  }

  // Endpoint yang dinonaktifkan admin: dijawab di sini, sebelum API key diperiksa, supaya tidak
  // mengurangi kuota harian. Batas per menit di atas tetap berlaku.
  const block = await endpointBlock(key);
  if (block) {
    const whole = block.path.endsWith("/*");
    return fail(
      503,
      `${whole ? `Semua endpoint '/api/${block.path.slice(0, -2)}'` : `Endpoint '/api/${key}'`} sedang dinonaktifkan oleh admin${block.reason ? `. Alasan: ${block.reason.replace(/[.\s]+$/, "")}` : ""}. Coba lagi nanti, atau lihat endpoint lain di ${origin}/docs.`,
      { ...rlHeaders, "x-endpoint-blocked": "1" },
      { blocked: true, reason: block.reason, docs: `${origin}/docs` },
    );
  }

  /** Kuota harian sudah habis: permintaan ini memotong limit tambahan. */
  let fromExtra = false;
  if (KEY_REQUIRED) {
    if (!apiKey) {
      return fail(
        401,
        `API key wajib diisi. Masuk di ${origin}/login untuk mendapat API key gratis, lalu tambahkan parameter apikey=yn-... (atau header x-api-key) ke permintaanmu.`,
        { ...rlHeaders, "www-authenticate": 'Bearer realm="api"' },
        { login: `${origin}/login` },
      );
    }
    const verdict = await verifyKey(apiKey);
    if (verdict === "error") return fail(503, "API key belum bisa diperiksa karena server akun tidak dapat dihubungi. Coba lagi sebentar lagi.", rlHeaders);
    if (verdict === "banned") return fail(403, `API key ini dinonaktifkan oleh pemilik situs. Untuk banding, hubungi owner lewat WhatsApp ${OWNER_WA}.`, rlHeaders, { appeal: APPEAL_URL });
    if (verdict === "blocked") {
      // Blokir API oleh admin: sementara (ada waktu berakhirnya) atau selamanya.
      const info = keyBlock(apiKey);
      const until = info && info.until > 0 ? info.until : 0;
      const reason = info?.reason ?? "";
      const why = reason ? ` Alasan: ${reason.replace(/[.\s]+$/, "")}.` : "";
      const when = until ? `${new Date(until).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })} WIB` : "";
      return fail(
        403,
        until
          ? `API key ini diblokir sementara oleh admin sampai ${when}.${why} Setelah itu key bisa dipakai lagi. Untuk banding, hubungi owner lewat WhatsApp ${OWNER_WA}.`
          : `API key ini diblokir permanen oleh admin.${why} Untuk banding, hubungi owner lewat WhatsApp ${OWNER_WA}.`,
        until ? { ...rlHeaders, "retry-after": String(Math.max(1, Math.ceil((until - Date.now()) / 1000))) } : rlHeaders,
        { key_blocked: true, permanent: !until, until: until ? new Date(until).toISOString() : null, reason, appeal: APPEAL_URL },
      );
    }
    if (verdict !== "ok") {
      return fail(403, `API key tidak valid atau sudah diganti. Lihat API key kamu yang berlaku di ${origin}/akun.`, rlHeaders, { login: `${origin}/login` });
    }

    // Kuota harian paket pemilik key. Terisi lagi pukul 00.00 WIB. Akun admin dan paket tanpa
    // batas tidak terkena kuota. Setelah kuota harian habis, permintaan memotong limit tambahan.
    const quota = keyQuota(apiKey);

    // Endpoint bertanda `pro` hanya untuk paket berbayar yang masih aktif. Diperiksa sebelum
    // kuota dipotong supaya penolakan tidak menghabiskan jatah harian pemilik key.
    if (endpoint.pro && !quota.admin && quota.plan.price <= 0) {
      return fail(
        403,
        `Endpoint '/api/${key}' khusus akun paket Pro, Enterprise, atau Bisnis. Akun kamu masih di paket ${quota.plan.name}. Naikkan paket di ${origin}/paket untuk memakainya.`,
        { ...rlHeaders, "x-plan": quota.plan.id, "x-requires-plan": "pro" },
        { pro_only: true, plan: quota.plan.id, upgrade: `${origin}/paket` },
      );
    }
    if (quota.unlimited) rlHeaders = { ...rlHeaders, "x-plan": quota.admin ? "admin" : quota.plan.id };
    const quotaHeaders = (left: number, extra: number) => ({ "x-plan": quota.plan.id, "x-quota-limit": String(quota.plan.daily), "x-quota-remaining": String(left), "x-quota-reset": String(quota.resetIn), "x-limit-extra": String(extra) });
    if (!quota.unlimited && quota.left <= 0) {
      if (quota.extra <= 0) {
        return fail(
          429,
          `Kuota harian paket ${quota.plan.name} (${formatNumber(quota.plan.daily)} permintaan) sudah habis dan akun ini tidak punya limit tambahan. Kuota terisi lagi pukul 00.00 WIB. Butuh lebih banyak? Naikkan paket atau beli limit tambahan di ${origin}/paket.`,
          { ...rlHeaders, ...quotaHeaders(0, 0), "retry-after": String(quota.resetIn) },
          { plan: quota.plan.id, quota: quota.plan.daily, used: quota.used, extra: 0, retry_after: quota.resetIn, upgrade: `${origin}/paket` },
        );
      }
      fromExtra = true;
    }
    keyUse(apiKey, fromExtra);
    if (!quota.unlimited) rlHeaders = { ...rlHeaders, ...quotaHeaders(fromExtra ? 0 : quota.left - 1, fromExtra ? quota.extra - 1 : quota.extra) };
  }

  // Pemilik key, untuk statistik pemakaian di /dashboard. null bila API key tidak diwajibkan.
  const ownerId = KEY_REQUIRED ? keyOwnerId(apiKey) : null;

  /** Kesalahan di sisi server tidak memotong limit tambahan: kembalikan satu limit yang tadi dipotong. */
  const refundExtra = () => {
    keyRefundExtra(apiKey);
    if (rlHeaders["x-limit-extra"] !== undefined) rlHeaders = { ...rlHeaders, "x-limit-extra": String(Number(rlHeaders["x-limit-extra"]) + 1) };
  };

  const started = Date.now();
  try {
    const result = await endpoint.handler({ req, sp, origin });
    recordHit(key);
    const status = result instanceof Response ? result.status : 200;
    if (fromExtra && status >= 500) refundExtra();
    recordUsage(ownerId, key, status, Date.now() - started, fromExtra && status < 500);

    if (result instanceof Response) {
      let res = result;
      if (KEY_REQUIRED) {
        // Tautan di halaman HTML yang menunjuk ke API ini harus ikut membawa API key.
        if ((res.headers.get("content-type") || "").startsWith("text/html") && res.ok) {
          res = new Response(withKeyInHtml(await res.text(), origin, apiKey), { status: res.status, headers: res.headers });
          res.headers.delete("content-length");
        }
        // Jawaban tidak boleh disimpan cache bersama: cache seperti itu akan melayani permintaan tanpa API key.
        const cache = res.headers.get("cache-control");
        if (cache && /public|s-maxage/i.test(cache)) res.headers.set("cache-control", `private, max-age=${/(?:^|[\s,])max-age=(\d+)/i.exec(cache)?.[1] ?? "0"}`);
      }
      for (const [k, v] of Object.entries({ ...CORS, ...rlHeaders })) res.headers.set(k, v);
      return res;
    }
    const body = KEY_REQUIRED ? withKeyInLinks(result, origin, apiKey) : result;
    return new NextResponse(JSON.stringify({ status: true, creator: SITE_CREATOR, result: body }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...rlHeaders },
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (fromExtra && status >= 500) refundExtra();
    recordUsage(ownerId, key, status, Date.now() - started, fromExtra && status < 500);
    if (e instanceof HttpError) return fail(e.status, e.message, rlHeaders);
    console.error(`[api/${key}]`, e);
    return fail(500, "Terjadi kesalahan internal pada server.", rlHeaders);
  }
}
