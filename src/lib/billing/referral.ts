import { supabaseRpc } from "@/db/store";
import { readCookie } from "@/lib/auth/session";
import { REFERRAL_PERCENT } from "@/lib/plans";

/**
 * Referral. Tautan referral berbentuk <situs>/daftar?ref=KODE. Skrip kecil di layout menyimpan
 * kodenya di cookie REF_COOKIE; saat pendaftar baru selesai masuk, server membaca cookie itu dan
 * mencatat pengundangnya. Hadiahnya diberikan setiap kali pesanan akun itu lunas.
 */
export const REF_COOKIE = "yn_ref";
export const REF_COOKIE_DAYS = 30;
export const REF_CODE_RE = /^[0-9A-Z]{6,12}$/;

/** Kode referral dari cookie permintaan ini, atau "" bila tidak ada atau bentuknya tidak sah. */
export function refFromRequest(req: Request): string {
  const code = (readCookie(req, REF_COOKIE) || "").toUpperCase();
  return REF_CODE_RE.test(code) ? code : "";
}

/** Header set-cookie yang menghapus cookie referral setelah dipakai. */
export function clearRefCookie(secure: boolean): string {
  return `${REF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Catat pengundang akun yang baru saja masuk, bila permintaannya membawa cookie referral.
 * Database hanya menerimanya untuk akun yang baru dibuat dan belum punya pengundang.
 * Tidak pernah melempar: gagal mencatat referral tidak boleh menggagalkan login.
 * Mengembalikan true bila cookie-nya ada, supaya pemanggil menghapusnya.
 */
export async function attachReferral(req: Request, userId: string): Promise<boolean> {
  const code = refFromRequest(req);
  if (!code) return false;
  try {
    await supabaseRpc<boolean>("ref_attach", { p_user: userId, p_code: code });
  } catch (e) {
    console.error("[referral/attach]", e instanceof Error ? e.message : e);
  }
  return true;
}

/**
 * Beri hadiah referral untuk pesanan yang sudah lunas. Aman dipanggil berkali-kali: database
 * hanya memberi hadiah sekali per pesanan. Tidak pernah melempar.
 */
export async function rewardReferral(orderId: string): Promise<void> {
  if (REFERRAL_PERCENT <= 0) return;
  try {
    await supabaseRpc("ref_reward", { p_order: orderId, p_percent: REFERRAL_PERCENT });
  } catch (e) {
    console.error("[referral/reward]", e instanceof Error ? e.message : e);
  }
}

export type ReferralSummary = {
  code: string;
  /** Total limit tambahan yang didapat dari referral. */
  earned: number;
  /** Akun yang mendaftar lewat tautan ini. */
  invited: number;
  /** Di antaranya, yang sudah pernah membeli. */
  buyers: number;
  rewards: { at: string; amount: number }[];
};

export function referralSummary(userId: string): Promise<ReferralSummary | null> {
  return supabaseRpc<ReferralSummary | null>("ref_summary", { p_user: userId });
}
