import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { adminBan, adminListBans, adminUnban } from "@/lib/guard";
import { adminBlockApi, adminListBlocks, adminUnblockApi, describeTarget, normalizeTarget, targetExists } from "@/lib/blocks";
import { IMAGE_NAME_RE, hasImageStore, listImages, removeImages } from "@/lib/images";
import { AUTH_BASE_READY, AUTH_ENABLED } from "@/lib/auth/config";
import { forgetAllKeys } from "@/lib/auth/apikey";
import { sameSite } from "@/lib/auth/origin";
import { sessionUserId } from "@/lib/auth/session";
import { HISTORY_KEEP, adminUserUsage } from "@/lib/auth/usage";
import { adminUsers, apiBlockedUsers, normalizeEmail, setAdmin, setApiBlock, setBanned, userById, type User } from "@/lib/auth/users";
import { adminOrders, adminSetPlan } from "@/lib/billing/orders";
import { FEE_ON_CUSTOMER, GATEWAY_READY, WEBHOOK_READY, pingGateway } from "@/lib/billing/welper";
import { PLANS, PLAN_DAYS, planById } from "@/lib/plans";
import { SITE_CREATOR, getOrigin } from "@/lib/site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Endpoint khusus owner dan akun admin untuk mengelola blokir IP, blokir API pengguna, blokir endpoint, gambar unggahan, akun pengguna, dan paket.
 *   /api/admin/bans?key=ADMIN_KEY               daftar IP yang diblokir
 *   /api/admin/unban?ip=1.2.3.4&key=ADMIN_KEY   buka blokir
 *   /api/admin/ban?ip=1.2.3.4&reason=..&key=..  blokir manual
 *   /api/admin/apiblocks?key=ADMIN_KEY          daftar endpoint yang dinonaktifkan
 *   /api/admin/apiblock?path=film/lk21&reason=..&key=..   nonaktifkan satu endpoint; path=film/* untuk satu kategori penuh
 *   /api/admin/apiunblock?path=film/lk21&key=.. aktifkan lagi
 *   /api/admin/images?key=ADMIN_KEY             100 gambar unggahan terbaru
 *   /api/admin/delimage?name=..&key=ADMIN_KEY   hapus satu gambar unggahan
 *   /api/admin/users?key=ADMIN_KEY              100 akun terbaru (API key disamarkan)
 *   /api/admin/userban?email=..&key=ADMIN_KEY   nonaktifkan akun beserta API key-nya
 *   /api/admin/userunban?email=..&key=..        aktifkan lagi
 *   /api/admin/userusage?email=..&key=..        riwayat pemakaian API satu akun: ringkasan, per hari, endpoint terbanyak, permintaan terakhir
 *   /api/admin/keyblocks?key=ADMIN_KEY          akun yang API-nya sedang diblokir
 *   /api/admin/keyblock?email=..&duration=7d&reason=..&key=..   blokir API sebuah akun: API key-nya ditolak, akunnya masih bisa masuk.
 *                                                        duration: 30m, 6h, 7d (menit/jam/hari), atau permanent (bawaan)
 *   /api/admin/keyunblock?email=..&key=..       buka blokir API
 *   /api/admin/setplan?email=..&plan=pro&days=30&key=..   beri paket tanpa pembayaran (menambah masa aktif);
 *                                                        plan=free mengembalikan akun ke paket gratis
 *   /api/admin/orders?key=ADMIN_KEY             100 pesanan paket terbaru dan total yang lunas
 *   /api/admin/paket?key=ADMIN_KEY              status konfigurasi pembayaran dan koneksi ke gateway
 *   /api/admin/setadmin?email=..&admin=1&key=ADMIN_KEY    jadikan akun admin (admin=0 mencabutnya); hanya dengan ADMIN_KEY
 * Kunci juga boleh dikirim lewat header `x-admin-key`.
 *
 * Tanpa kunci, endpoint ini menerima sesi login akun admin (dipakai halaman /admin). Permintaan
 * seperti itu harus datang dari halaman situs ini sendiri dan membawa header
 * `x-requested-with: yanz-admin`, supaya tautan atau halaman di situs lain tidak bisa
 * menjalankan aksi admin lewat browser admin yang sedang masuk.
 */
const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json({ status: status < 400, code: status, creator: SITE_CREATOR, ...body }, { status, headers: { "cache-control": "no-store" } });

function keyMatches(given: string) {
  const key = (process.env.ADMIN_KEY || "").trim();
  if (!key) return null;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Lama blokir API dari parameter `duration`, dalam milidetik. 0 berarti selamanya (juga bila
 * parameternya kosong); null bila bentuknya salah atau di luar rentang 1 menit sampai 3650 hari.
 */
function blockSpan(raw: string | null): number | null {
  const s = (raw || "").trim().toLowerCase();
  if (!s || s === "permanent" || s === "permanen" || s === "selamanya" || s === "forever") return 0;
  const m = /^(\d{1,7})\s*(m|h|d)$/.exec(s);
  if (!m) return null;
  const ms = Number(m[1]) * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
  return ms >= 60_000 && ms <= 3650 * 86_400_000 ? ms : null;
}

/** Siapa yang memanggil: pemegang ADMIN_KEY, atau akun admin yang sedang masuk. */
type Caller = { via: "key" } | { via: "session"; user: User };

async function caller(req: Request, sp: URLSearchParams): Promise<Caller | NextResponse> {
  const given = sp.get("key") || req.headers.get("x-admin-key") || "";
  if (given) {
    const ok = keyMatches(given);
    if (ok === null) return json(503, { error: "ADMIN_KEY belum diatur di environment variable server." });
    return ok ? { via: "key" } : json(401, { error: "Kunci admin salah." });
  }
  const id = AUTH_ENABLED ? sessionUserId(req) : null;
  if (!id) return json(401, { error: "Butuh kunci admin, atau masuk dengan akun admin." });
  if (req.headers.get("x-requested-with") !== "yanz-admin" || !sameSite(req)) return json(403, { error: "Aksi admin dengan sesi login hanya bisa dijalankan dari halaman /admin." });
  let user: User | null;
  try {
    user = await userById(id);
  } catch (e) {
    console.error("[api/admin] sesi", e);
    return json(503, { error: "Server akun sedang tidak dapat dihubungi. Coba lagi sebentar lagi." });
  }
  if (!user || user.banned) return json(401, { error: "Sesi berakhir. Masuk lagi." });
  if (user.is_admin !== true) return json(403, { error: "Akun ini bukan akun admin." });
  return { via: "session", user };
}

export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const who = await caller(req, sp);
  if (who instanceof NextResponse) return who;

  try {
    if (action === "bans") {
      const bans = await adminListBans();
      return json(200, { result: { total: bans.length, bans } });
    }
    if (action === "apiblocks") {
      const blocks = (await adminListBlocks()).map((b) => ({ ...b, ...describeTarget(b.path) }));
      return json(200, { result: { total: blocks.length, blocks } });
    }
    if (action === "apiblock" || action === "apiunblock") {
      const target = normalizeTarget(sp.get("path"));
      if (!target) return json(400, { error: "Parameter 'path' wajib diisi dengan endpoint, mis. film/lk21, atau satu kategori penuh, mis. film/*." });
      const shown = `/api/${target}`;
      if (action === "apiunblock") {
        if (!(await adminUnblockApi(target))) return json(404, { error: `${shown} tidak sedang diblokir.` });
        return json(200, { result: { path: target, blocked: false, message: `${shown} aktif lagi. Berlaku penuh di semua server dalam ±30 detik.` } });
      }
      if (!targetExists(target)) return json(404, { error: `Tidak ada endpoint ${shown}. Lihat daftar endpoint di /docs atau GET /api.` });
      const reason = (sp.get("reason") || "").trim().slice(0, 300);
      await adminBlockApi(target, reason);
      return json(200, { result: { path: target, blocked: true, reason, ...describeTarget(target), message: `${shown} dinonaktifkan. Berlaku penuh di semua server dalam ±30 detik.` } });
    }
    if (action === "images" || action === "delimage") {
      if (!hasImageStore()) return json(503, { error: "Penyimpanan gambar belum dikonfigurasi di server ini." });
      if (action === "images") {
        const origin = getOrigin(req);
        const images = (await listImages(100, "desc")).map((i) => ({ ...i, url: `${origin}/i/${i.name}` }));
        return json(200, { result: { total: images.length, images } });
      }
      // Boleh diisi nama berkas saja atau tautan lengkapnya.
      const name = (sp.get("name") || "").trim().split("/").pop() ?? "";
      if (!IMAGE_NAME_RE.test(name)) return json(400, { error: "Parameter 'name' wajib diisi dengan nama berkas gambar, mis. aB3dE5fG7h.png." });
      const removed = await removeImages([name]);
      if (!removed) return json(404, { error: "Gambar tidak ditemukan atau sudah dihapus." });
      return json(200, { result: { name, deleted: true, message: "Gambar dihapus. Salinan di cache bisa masih tampil paling lama satu jam." } });
    }
    if (action === "paket") {
      const origin = getOrigin(req);
      return json(200, {
        result: {
          plans: PLANS,
          plan_days: PLAN_DAYS,
          api_key_set: GATEWAY_READY,
          webhook_secret_set: WEBHOOK_READY,
          fee_bearer: FEE_ON_CUSTOMER ? "customer" : "merchant",
          gateway_reachable: await pingGateway(),
          webhook_url: `${origin}/api/paket/webhook`,
        },
      });
    }
    if (action === "users" || action === "userban" || action === "userunban" || action === "setplan" || action === "orders" || action === "setadmin" || action === "keyblocks" || action === "keyblock" || action === "keyunblock" || action === "userusage") {
      if (!AUTH_BASE_READY) return json(503, { error: "Login belum dikonfigurasi di server ini (butuh Supabase dan AUTH_SECRET)." });
      if (action === "userusage") {
        const email = normalizeEmail(sp.get("email"));
        if (!email) return json(400, { error: "Parameter 'email' wajib diisi dengan alamat email akun." });
        const found = await adminUserUsage(email);
        if (!found) return json(404, { error: "Tidak ada akun dengan email itu." });
        return json(200, { result: { ...found, kept: HISTORY_KEEP } });
      }
      if (action === "keyblocks") {
        const users = await apiBlockedUsers(200);
        return json(200, { result: { total: users.length, users } });
      }
      if (action === "keyblock" || action === "keyunblock") {
        const email = normalizeEmail(sp.get("email"));
        if (!email) return json(400, { error: "Parameter 'email' wajib diisi dengan alamat email akun." });
        if (action === "keyunblock") {
          const set = await setApiBlock(email, false, null, "");
          if (!set) return json(404, { error: "Tidak ada akun dengan email itu." });
          forgetAllKeys();
          return json(200, { result: { email, blocked: false, message: "Blokir API dibuka. API key akun ini kembali berfungsi paling lama satu menit lagi." } });
        }
        if (who.via === "session" && email === who.user.email) return json(400, { error: "Kamu tidak bisa memblokir API akunmu sendiri." });
        const span = blockSpan(sp.get("duration"));
        if (span === null) return json(400, { error: "Parameter 'duration' harus berupa angka dengan satuan m, h, atau d (mis. 30m, 6h, 7d; paling lama 3650d), atau 'permanent' untuk selamanya." });
        const until = span > 0 ? new Date(Date.now() + span).toISOString() : null;
        const reason = (sp.get("reason") || "").trim().slice(0, 300);
        const set = await setApiBlock(email, true, until, reason);
        if (!set) return json(404, { error: "Tidak ada akun dengan email itu, atau akun itu admin. API akun admin tidak bisa diblokir sebelum status adminnya dicabut." });
        forgetAllKeys();
        return json(200, {
          result: { email, username: set.username, blocked: true, permanent: !until, until, reason, message: `API akun ini diblokir ${until ? "sementara" : "selamanya"}. API key-nya berhenti berfungsi paling lama satu menit lagi; akunnya masih bisa masuk ke situs.` },
        });
      }
      if (action === "setadmin") {
        // Hanya pemegang ADMIN_KEY yang boleh menambah atau mencabut admin; akun admin tidak bisa mengangkat admin lain.
        if (who.via !== "key") return json(403, { error: "Status admin hanya bisa diubah dengan ADMIN_KEY." });
        const email = normalizeEmail(sp.get("email"));
        if (!email) return json(400, { error: "Parameter 'email' wajib diisi dengan alamat email akun." });
        const flag = (sp.get("admin") ?? "1").trim().toLowerCase();
        if (!["1", "0", "true", "false"].includes(flag)) return json(400, { error: "Parameter 'admin' harus 1 (jadikan admin) atau 0 (cabut)." });
        const set = await setAdmin(email, flag === "1" || flag === "true");
        if (!set) return json(404, { error: "Tidak ada akun dengan email itu." });
        forgetAllKeys();
        return json(200, { result: { ...set, message: set.is_admin ? "Akun ini sekarang admin: bisa membuka /admin dan tidak terkena kuota harian." : "Status admin dicabut." } });
      }
      if (action === "users") return json(200, { result: await adminUsers(100) });
      if (action === "orders") return json(200, { result: await adminOrders(100) });
      if (action === "setplan") {
        const email = normalizeEmail(sp.get("email"));
        if (!email) return json(400, { error: "Parameter 'email' wajib diisi dengan alamat email akun." });
        const plan = planById((sp.get("plan") || "").trim().toLowerCase());
        if (!plan) return json(400, { error: `Parameter 'plan' wajib diisi dengan salah satu dari: ${PLANS.map((p) => p.id).join(", ")}.` });
        const days = plan.price > 0 ? Number(sp.get("days") ?? PLAN_DAYS) : 0;
        if (plan.price > 0 && !(Number.isInteger(days) && days >= 1 && days <= 3650)) return json(400, { error: "Parameter 'days' harus bilangan bulat 1 sampai 3650." });
        const set = await adminSetPlan(email, plan.id, days);
        if (!set) return json(404, { error: "Tidak ada akun dengan email itu." });
        forgetAllKeys();
        return json(200, { result: { ...set, message: "Paket diperbarui. Berlaku di semua server paling lama satu menit lagi." } });
      }
      const email = normalizeEmail(sp.get("email"));
      if (!email) return json(400, { error: "Parameter 'email' wajib diisi dengan alamat email akun." });
      const banned = action === "userban";
      if (banned && who.via === "session" && email === who.user.email) return json(400, { error: "Kamu tidak bisa menonaktifkan akunmu sendiri." });
      if (!(await setBanned(email, banned))) {
        return json(404, { error: banned ? "Tidak ada akun dengan email itu, atau akun itu admin. Akun admin tidak bisa dinonaktifkan sebelum status adminnya dicabut." : "Tidak ada akun dengan email itu." });
      }
      forgetAllKeys();
      return json(200, {
        result: { email, banned, message: banned ? "Akun dinonaktifkan. API key-nya berhenti berfungsi paling lama satu menit lagi." : "Akun diaktifkan lagi. API key-nya kembali berfungsi paling lama setengah menit lagi." },
      });
    }
    const ip = (sp.get("ip") || "").trim().toLowerCase();
    if (action === "unban" || action === "ban") {
      if (!/^[0-9a-f:.]{3,45}$/.test(ip)) return json(400, { error: "Parameter 'ip' wajib diisi dengan alamat IP yang valid." });
      if (action === "unban") {
        await adminUnban(ip);
        return json(200, { result: { ip, banned: false, message: "Blokir dibuka. Berlaku penuh di semua server dalam ±30 detik." } });
      }
      const reason = (sp.get("reason") || "Diblokir manual oleh owner").slice(0, 300);
      await adminBan(ip, reason);
      return json(200, { result: { ip, banned: true, reason } });
    }
    return json(404, { error: "Aksi tidak dikenal. Gunakan: bans, ban, unban, userusage, keyblocks, keyblock, keyunblock, apiblocks, apiblock, apiunblock, images, delimage, users, userban, userunban, setplan, setadmin, orders, paket." });
  } catch (e) {
    console.error("[api/admin]", e);
    return json(502, { error: "Gagal menghubungi database atau penyimpanan." });
  }
}
