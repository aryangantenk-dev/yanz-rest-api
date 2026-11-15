import { after } from "next/server";
import { supabaseRpc } from "@/db/store";

/* Statistik dan riwayat pemakaian per akun untuk halaman /dashboard dan /admin (tabel api_usage dan api_usage_log di supabase/schema.sql). */

export type UsageDay = { day: string; hits: number; errors: number };
export type UsageTop = { path: string; hits: number; errors: number };

export type Usage = {
  today: number;
  today_errors: number;
  week: number;
  week_errors: number;
  month: number;
  month_errors: number;
  total: number;
  total_errors: number;
  /** Waktu permintaan pertama dan terakhir yang tercatat; null bila belum ada. */
  first_at: string | null;
  last_at: string | null;
  /** Banyaknya endpoint berbeda yang dipakai dalam 30 hari terakhir. */
  endpoints: number;
  /** Deret harian, dari yang paling lama sampai hari ini (WIB). */
  days: UsageDay[];
  top: UsageTop[];
};

/** Satu baris riwayat: satu permintaan yang sudah diproses, dengan kode status dan lama prosesnya. */
export type UsageHit = { at: string; path: string; status: number; ms: number };

/** Banyaknya hari pada deret harian di dashboard. */
export const USAGE_DAYS = 14;
/** Banyaknya permintaan terakhir yang disimpan di riwayat tiap akun (sama dengan batas di auth_usage_record). */
export const HISTORY_KEEP = 200;

/**
 * Catat satu permintaan milik sebuah akun: naikkan hitungan hariannya dan tambahkan ke riwayat.
 * Dijalankan setelah respons terkirim supaya tidak memperlambat API; kegagalan mencatat tidak
 * pernah mengganggu permintaannya. Status 400 ke atas dihitung sebagai gagal.
 * `extra`: permintaan ini memotong satu limit tambahan milik akunnya.
 */
export function recordUsage(userId: string | null, path: string, status: number, ms: number, extra = false) {
  if (!userId) return;
  const task = () =>
    supabaseRpc("auth_usage_record", { p_id: userId, p_path: path, p_ok: status < 400, p_status: status, p_ms: Math.max(0, Math.round(ms)), p_extra: extra }).catch(() => {
      /* diabaikan */
    });
  try {
    after(task);
  } catch {
    void task();
  }
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

function parseUsage(raw: Record<string, unknown>): Usage {
  return {
    today: num(raw.today),
    today_errors: num(raw.today_errors),
    week: num(raw.week),
    week_errors: num(raw.week_errors),
    month: num(raw.month),
    month_errors: num(raw.month_errors),
    total: num(raw.total),
    total_errors: num(raw.total_errors),
    first_at: typeof raw.first_at === "string" ? raw.first_at : null,
    last_at: typeof raw.last_at === "string" ? raw.last_at : null,
    endpoints: num(raw.endpoints),
    days: list(raw.days).map((d) => ({ day: String(d.day).slice(0, 10), hits: num(d.hits), errors: num(d.errors) })),
    top: list(raw.top).map((t) => ({ path: String(t.path), hits: num(t.hits), errors: num(t.errors) })),
  };
}

function parseHistory(raw: unknown): UsageHit[] {
  return list(raw)
    .filter((h) => typeof h.at === "string" && typeof h.path === "string")
    .map((h) => ({ at: String(h.at), path: String(h.path), status: num(h.status) || 200, ms: num(h.ms) }));
}

export async function usageSummary(userId: string): Promise<Usage> {
  return parseUsage((await supabaseRpc<Record<string, unknown> | null>("auth_usage_summary", { p_id: userId, p_days: USAGE_DAYS })) ?? {});
}

/** Permintaan terakhir milik sebuah akun, dari yang paling baru. */
export async function usageHistory(userId: string, limit = HISTORY_KEEP): Promise<UsageHit[]> {
  return parseHistory(await supabaseRpc<unknown>("auth_usage_history", { p_id: userId, p_limit: limit }));
}

export type AdminUserUsage = {
  user: { email: string; username: string; is_admin: boolean; plan: string; created_at: string | null };
  usage: Usage;
  history: UsageHit[];
};

/** Untuk owner dan admin (/api/admin/userusage): ringkasan dan riwayat pemakaian satu akun. null bila akunnya tidak ada. */
export async function adminUserUsage(email: string, limit = HISTORY_KEEP): Promise<AdminUserUsage | null> {
  const raw = await supabaseRpc<Record<string, unknown> | null>("auth_admin_usage", { p_email: email, p_days: USAGE_DAYS, p_limit: limit });
  if (!raw || typeof raw !== "object") return null;
  const u = (raw.user ?? {}) as Record<string, unknown>;
  return {
    user: { email: String(u.email ?? email), username: String(u.username ?? ""), is_admin: u.is_admin === true, plan: String(u.plan ?? "free"), created_at: typeof u.created_at === "string" ? u.created_at : null },
    usage: parseUsage((raw.usage ?? {}) as Record<string, unknown>),
    history: parseHistory(raw.history),
  };
}
