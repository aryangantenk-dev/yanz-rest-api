import { after } from "next/server";
import { supabaseRpc } from "@/db/store";

/* Statistik pemakaian per akun untuk halaman /dashboard (tabel api_usage di supabase/schema.sql). */

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

/** Banyaknya hari pada deret harian di dashboard. */
export const USAGE_DAYS = 14;

/**
 * Catat satu permintaan milik sebuah akun. Dijalankan setelah respons terkirim supaya
 * tidak memperlambat API; kegagalan mencatat tidak pernah mengganggu permintaannya.
 */
export function recordUsage(userId: string | null, path: string, ok: boolean) {
  if (!userId) return;
  const task = () =>
    supabaseRpc("auth_usage_hit", { p_id: userId, p_path: path, p_ok: ok }).catch(() => {
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

export async function usageSummary(userId: string): Promise<Usage> {
  const raw = (await supabaseRpc<Record<string, unknown> | null>("auth_usage_summary", { p_id: userId, p_days: USAGE_DAYS })) ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
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
