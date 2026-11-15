import { randomInt } from "node:crypto";
import { supabaseRpc } from "@/db/store";
import { forgetAllKeys } from "@/lib/auth/apikey";

/** Kode hadiah buatan admin: berisi paket (`plan` + `days`), limit tambahan (`qty`), atau keduanya. */
export type Code = {
  code: string;
  /** Id paket, atau "" bila kode ini hanya berisi limit. */
  plan: string;
  days: number;
  qty: number;
  /** Berapa kali kode boleh ditukar; null = tanpa batas. */
  max_uses: number | null;
  used: number;
  /** null = tidak kedaluwarsa. */
  expires_at: string | null;
  note: string;
  created_at: string;
  /** Lima penukar terakhir (username atau email). Hanya ada di daftar untuk admin. */
  recent?: { who: string; used_at: string }[];
};

/** Bentuk kode yang diterima: 4 sampai 32 karakter, huruf besar, angka, dan tanda hubung di tengah. */
export const CODE_RE = /^[0-9A-Z][0-9A-Z-]{2,30}[0-9A-Z]$/;

/** Rapikan kode yang diketik orang: buang spasi, jadikan huruf besar. "" bila bentuknya tidak sah. */
export function cleanCode(raw: unknown): string {
  const code = typeof raw === "string" ? raw.replace(/\s+/g, "").toUpperCase() : "";
  return CODE_RE.test(code) ? code : "";
}

// Tanpa 0, O, 1, I, dan L supaya kode mudah dibaca dan diketik ulang.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Kode acak berbentuk YANZ-XXXX-XXXX. */
export function randomCode(): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `YANZ-${part()}-${part()}`;
}

export type CodeInput = { code: string; plan: string; days: number; qty: number; maxUses: number | null; expiresAt: string | null; note: string };

/** Simpan kode baru. null bila kode itu sudah ada. */
export async function createCode(c: CodeInput): Promise<Code | null> {
  const res = await supabaseRpc<{ status: "ok"; code: Code } | { status: "exists" }>("code_create", {
    p_code: c.code,
    p_plan: c.plan,
    p_days: c.days,
    p_qty: c.qty,
    p_max: c.maxUses,
    p_expires: c.expiresAt,
    p_note: c.note,
  });
  return res.status === "ok" ? res.code : null;
}

export async function listCodes(limit = 200): Promise<Code[]> {
  return (await supabaseRpc<Code[] | null>("code_list", { p_limit: limit })) ?? [];
}

export function deleteCode(code: string): Promise<boolean> {
  return supabaseRpc<boolean>("code_delete", { p_code: code });
}

export type Redeemed =
  | { status: "ok"; plan: string; days: number; qty: number; user_plan: string; plan_expires_at: string | null; extra_limit: number }
  /** Akun punya paket berbayar lain yang masih aktif; belum ada yang diubah sampai penukaran dikonfirmasi. */
  | { status: "conflict"; plan: string; days: number; qty: number; current: string; current_until: string | null }
  | { status: "none" | "expired" | "used_up" | "already" };

/** Tukarkan kode untuk sebuah akun. `force`: pengguna sudah setuju paket aktifnya diganti. */
export async function redeemCode(userId: string, code: string, force: boolean): Promise<Redeemed> {
  const res = await supabaseRpc<Redeemed>("code_redeem", { p_user: userId, p_code: code, p_force: force });
  // Paket atau limit baru langsung berlaku di instance ini; instance lain menyusul paling lama satu menit.
  if (res.status === "ok") forgetAllKeys();
  return res;
}
