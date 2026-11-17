import { NextResponse } from "next/server";
import { AUTH_ENABLED } from "@/lib/auth/config";
import { hit } from "@/lib/auth/limit";
import { sameSite } from "@/lib/auth/origin";
import { clearSessionCookie, isSecure, sessionUserId } from "@/lib/auth/session";
import { CHAT_MAX_LENGTH, cleanChatText, hasApiKey } from "@/lib/chat";
import { chatDelete, chatList, chatPost } from "@/lib/chat-store";
import { SITE_CREATOR } from "@/lib/site";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Rute chat global untuk halaman /chat (bukan bagian dari API publik; memakai sesi login, bukan API key).
 *   GET  /api/chat/messages?after=ID   pesan terakhir, atau hanya yang lebih baru dari ID
 *   POST /api/chat/send     { text }   kirim pesan
 *   POST /api/chat/delete   { id }     hapus pesan sendiri (admin: pesan siapa pun)
 */
function json(status: number, body: Record<string, unknown>, setCookie?: string) {
  const res = NextResponse.json({ status: status < 400, creator: SITE_CREATOR, ...body }, { status, headers: { "cache-control": "no-store, private" } });
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, setCookie?: string) => json(status, { code: status, error, ...extra }, setCookie);

const STORE_DOWN = "Server chat sedang tidak dapat dihubungi. Coba lagi sebentar lagi.";
const SIGN_IN = "Masuk dulu untuk membuka chat global.";
const SESSION_OVER = "Sesi berakhir. Masuk lagi untuk membuka chat global.";

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (text.length > 8000) return {};
    const body = JSON.parse(text) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action !== "messages") return fail(404, "Aksi tidak dikenal.");
  const id = AUTH_ENABLED ? sessionUserId(req) : null;
  if (!id) return fail(401, SIGN_IN);
  // Halaman bertanya tiap beberapa detik; batas ini hanya menahan skrip yang bertanya jauh lebih sering.
  const wait = hit("chat-read", id, 90, 60_000);
  if (wait) return fail(429, "Terlalu sering memuat chat. Tunggu sebentar.", { wait });
  const raw = new URL(req.url).searchParams.get("after") || "0";
  const after = /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  try {
    const list = await chatList(id, after);
    if (!list) return fail(401, SESSION_OVER, {}, clearSessionCookie(isSecure(req)));
    return json(200, { messages: list.messages, removed: list.removed });
  } catch (e) {
    console.error("[chat/messages]", e);
    return fail(503, STORE_DOWN);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action !== "send" && action !== "delete") return fail(404, "Aksi tidak dikenal.");
  if (!sameSite(req)) return fail(403, "Permintaan ditolak.");
  const id = AUTH_ENABLED ? sessionUserId(req) : null;
  if (!id) return fail(401, SIGN_IN);
  const body = await readBody(req);

  try {
    if (action === "delete") {
      const messageId = typeof body.id === "number" && Number.isSafeInteger(body.id) && body.id > 0 ? body.id : 0;
      if (!messageId) return fail(400, "Pesan tidak dikenal.");
      const wait = hit("chat-delete", id, 60, 60_000);
      if (wait) return fail(429, "Terlalu banyak menghapus. Tunggu sebentar.", { wait });
      // false juga berarti pesannya sudah dihapus lebih dulu; bagi pengirim permintaan hasilnya sama: pesannya tidak ada lagi.
      const removed = await chatDelete(messageId, id);
      if (!removed) return fail(404, "Pesan itu sudah tidak ada, atau bukan pesanmu.");
      return json(200, { id: messageId });
    }

    const text = cleanChatText(body.text);
    if (!text) return fail(400, "Pesan masih kosong.");
    if (text.length > CHAT_MAX_LENGTH) return fail(400, `Pesan terlalu panjang. Paling banyak ${CHAT_MAX_LENGTH} karakter.`);
    if (hasApiKey(text)) return fail(400, "Pesanmu memuat API key. Jangan bagikan API key di chat: siapa pun yang melihatnya bisa memakai kuotamu.");
    // Lapisan pertama (per instance server); batas yang berlaku di semua instance ada di fungsi chat_post.
    const burst = hit("chat-send", id, 30, 60_000);
    if (burst) return fail(429, `Terlalu banyak pesan. Coba lagi dalam ${burst} detik.`, { wait: burst });

    const res = await chatPost(id, text);
    if (res.status === "ok") return json(200, { message: res.message });
    if (res.status === "cooldown") return fail(429, `Tunggu ${res.wait} detik sebelum mengirim pesan berikutnya.`, { wait: res.wait });
    if (res.status === "limit") return fail(429, `Terlalu banyak pesan dalam satu menit. Coba lagi dalam ${res.wait} detik.`, { wait: res.wait });
    if (res.status === "invalid") return fail(400, "Pesan tidak bisa dikirim. Periksa isinya, lalu coba lagi.");
    return fail(403, "Akunmu belum bisa mengirim pesan. Pastikan kamu sudah masuk dan sudah memilih username.");
  } catch (e) {
    console.error(`[chat/${action}]`, e);
    return fail(503, STORE_DOWN);
  }
}
