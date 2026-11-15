import { RATE_LIMIT } from "./limits";

/**
 * Daftar paket. Satu-satunya tempat untuk mengubah nama, harga, dan kuota: halaman /paket,
 * pembatas di /api/*, dashboard, dan pembayaran semuanya membaca dari sini.
 * Tanpa dependensi server, jadi aman diimpor dari komponen "use client".
 *
 * Menambah paket: tambahkan satu entri di PLANS dan id-nya di PlanId. Database hanya
 * menyimpan id paket, jadi tidak perlu migrasi.
 */
export type PlanId = "free" | "pro";

export type Plan = {
  id: PlanId;
  name: string;
  /** Harga dalam rupiah untuk PLAN_DAYS hari. 0 = gratis. */
  price: number;
  /** Kuota permintaan per hari (WIB) untuk satu akun. */
  daily: number;
  /** Batas permintaan per menit untuk setiap alamat IP. */
  perMinute: number;
  /** Untuk siapa paket ini, satu kalimat. */
  blurb: string;
};

export const PLANS: readonly Plan[] = [
  { id: "free", name: "Gratis", price: 0, daily: 1_000, perMinute: RATE_LIMIT, blurb: "Untuk belajar, proyek hobi, dan bot pribadi." },
  { id: "pro", name: "Pro", price: 15_000, daily: 50_000, perMinute: Math.max(300, RATE_LIMIT), blurb: "Untuk bot dan aplikasi yang dipakai banyak orang." },
];

/** Lama satu masa aktif paket berbayar, dalam hari. */
export const PLAN_DAYS = 30;
/** Pilihan lama berlangganan dalam sekali bayar (kelipatan PLAN_DAYS). */
export const PLAN_MONTHS: readonly number[] = [1, 3, 6, 12];

export const FREE_PLAN = PLANS[0];

export function planById(id: string | null | undefined): Plan | null {
  return PLANS.find((p) => p.id === id) ?? null;
}

/** Paket yang sedang berlaku: paket berbayar yang masa aktifnya sudah lewat dihitung sebagai gratis. */
export function activePlan(id: string | null | undefined, expiresAt: string | number | null | undefined, now = Date.now()): Plan {
  const plan = planById(id);
  if (!plan || plan.price === 0) return FREE_PLAN;
  const until = typeof expiresAt === "number" ? expiresAt : expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(until) && until > now ? plan : FREE_PLAN;
}

const nf = new Intl.NumberFormat("id-ID");
export const formatNumber = (n: number) => nf.format(n);
export const rupiah = (n: number) => `Rp${nf.format(n)}`;
