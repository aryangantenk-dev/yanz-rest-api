import { supabaseRpc } from "@/db/store";
import { CHAT_COOLDOWN_SEC, CHAT_KEEP, CHAT_PAGE, CHAT_PER_MINUTE, type ChatMessage } from "@/lib/chat";

/* Akses data chat global. Semua lewat fungsi Postgres di supabase/schema.sql (bagian "Chat global"). */

type Row = Omit<ChatMessage, "photo" | "admin"> & { photo: string | null; admin: boolean | null };

/** Baris dari database -> bentuk untuk browser (nama berkas foto menjadi alamat di situs ini). */
const view = (r: Row): ChatMessage => ({ id: Number(r.id), body: r.body, at: r.at, username: r.username || "", photo: r.photo ? `/avatar/${r.photo}` : "", admin: r.admin === true });

export type ChatList = {
  /** Urut dari yang paling lama. */
  messages: ChatMessage[];
  /** Id pesan lama yang baru saja dihapus (hanya diisi bila `after` > 0). */
  removed: number[];
};

/**
 * Pesan untuk akun `userId`. `after` = 0 memuat pesan-pesan terakhir; `after` > 0 hanya yang lebih
 * baru dari id itu. null bila akunnya tidak ada atau dinonaktifkan.
 */
export async function chatList(userId: string, after: number): Promise<ChatList | null> {
  const res = await supabaseRpc<{ messages: Row[] | null; removed: number[] | null } | null>("chat_list", { p_user: userId, p_after: after, p_limit: CHAT_PAGE });
  if (!res) return null;
  return { messages: (res.messages ?? []).map(view), removed: (res.removed ?? []).map(Number) };
}

export type ChatPost = { status: "ok"; message: ChatMessage } | { status: "cooldown" | "limit"; wait: number } | { status: "none" | "invalid" };

/** Simpan pesan. Batas kecepatan diperiksa di database, jadi berlaku di semua instance server. */
export async function chatPost(userId: string, body: string): Promise<ChatPost> {
  const res = await supabaseRpc<{ status: string; wait?: number; message?: Row }>("chat_post", { p_user: userId, p_body: body, p_cooldown: CHAT_COOLDOWN_SEC, p_per_minute: CHAT_PER_MINUTE, p_keep: CHAT_KEEP });
  if (res.status === "ok" && res.message) return { status: "ok", message: view(res.message) };
  if (res.status === "cooldown" || res.status === "limit") return { status: res.status, wait: Math.max(1, Number(res.wait) || 1) };
  return { status: res.status === "invalid" ? "invalid" : "none" };
}

/** Hapus pesan atas nama `userId`. false bila pesannya tidak ada, sudah dihapus, atau bukan haknya. */
export function chatDelete(id: number, userId: string): Promise<boolean> {
  return supabaseRpc<boolean>("chat_delete", { p_id: id, p_by: userId });
}
