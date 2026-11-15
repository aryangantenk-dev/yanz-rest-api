import { RATE_LIMIT } from "./limits";

/**
 * Daftar paket. Satu-satunya tempat untuk mengubah nama, harga, dan kuota: halaman /paket,
 * pembatas di /api/*, dashboard, dan pembayaran semuanya membaca dari sini.
 * Tanpa dependensi server, jadi aman diimpor dari komponen "use client".
 *
 * Menambah paket: tambahkan satu entri di PLANS dan id-nya di PlanId. Database hanya
 * menyimpan id paket, jadi tidak perlu migrasi.
 */
export type PlanId = "free" | "pro" | "enterprise" | "bisnis";

export type Plan = {
  id: PlanId;
  name: string;
  /** Harga dalam rupiah untuk satu hari. 0 = gratis. Pembeli memilih sendiri jumlah harinya. */
  price: number;
  /** Kuota permintaan per hari (WIB) untuk satu akun. 0 dan tidak dipakai bila `unlimited`. */
  daily: number;
  /** Tanpa kuota harian: permintaan hanya dibatasi oleh `perMinute`. */
  unlimited?: boolean;
  /** Batas permintaan per menit untuk setiap alamat IP. */
  perMinute: number;
  /** Untuk siapa paket ini, satu kalimat. */
  blurb: string;
};

export const PLANS: readonly Plan[] = [
  { id: "free", name: "Gratis", price: 0, daily: 50, perMinute: RATE_LIMIT, blurb: "Untuk mencoba API dan belajar." },
  { id: "pro", name: "Pro", price: 1_000, daily: 1_000, perMinute: Math.max(300, RATE_LIMIT), blurb: "Untuk bot pribadi dan proyek hobi." },
  { id: "enterprise", name: "Enterprise", price: 2_500, daily: 7_000, perMinute: Math.max(300, RATE_LIMIT), blurb: "Untuk bot dan aplikasi yang dipakai banyak orang." },
  { id: "bisnis", name: "Bisnis", price: 5_000, daily: 0, unlimited: true, perMinute: Math.max(600, RATE_LIMIT), blurb: "Tanpa kuota harian, untuk layanan yang ramai sepanjang hari." },
];

/** Lama bawaan saat admin memberi paket lewat panel admin, dalam hari. */
export const PLAN_DAYS = 30;
/** Pilihan cepat jumlah hari di halaman /paket; pembeli juga bisa mengisi sendiri. */
export const PLAN_DAY_CHOICES: readonly number[] = [1, 3, 7, 30];
/** Jumlah hari terbanyak dalam sekali bayar. */
export const MAX_PLAN_DAYS = 365;

/**
 * Limit tambahan: saldo permintaan yang dibeli terpisah dari paket. Dipakai setelah kuota
 * harian habis, tidak hangus, dan tidak terisi ulang sendiri. Pesanannya memakai id paket LIMIT_PLAN.
 */
export const LIMIT_PLAN = "limit";
/** Harga satu limit (satu permintaan), dalam rupiah: 100 limit = Rp100. */
export const LIMIT_PRICE = 1;
/** Pembelian harus kelipatan ini. */
export const LIMIT_STEP = 100;
/** Pembelian terkecil; payment gateway tidak menerima pembayaran di bawah Rp1.000. */
export const LIMIT_MIN = 1_000;
export const LIMIT_MAX = 1_000_000;
/** Pilihan cepat jumlah limit di halaman /paket. */
export const LIMIT_CHOICES: readonly number[] = [1_000, 5_000, 10_000, 50_000];

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

/** Batas per menit untuk akun admin, dihitung per akun. Akun admin tidak terkena kuota harian. */
export const ADMIN_PER_MINUTE = Math.max(600, ...PLANS.map((p) => p.perMinute));

/** Paket sebuah akun dalam bentuk yang dikirim ke browser (halaman /paket dan /dashboard). */
export type PlanView = {
  id: string;
  name: string;
  /** Kuota per hari; 0 dan tidak dipakai bila `unlimited`. */
  daily: number;
  perMinute: number;
  /** Paket berbayar yang masih aktif. */
  paid: boolean;
  expires_at: string | null;
  /** Tanpa kuota harian: akun admin (id "admin") atau paket tanpa batas. */
  unlimited: boolean;
  /** Saldo limit tambahan, dipakai setelah kuota harian habis. */
  extra: number;
};

export function planView(id: string | null | undefined, expiresAt: string | null | undefined, admin = false, extra: number | null | undefined = 0): PlanView {
  const left = Math.max(0, Math.floor(Number(extra) || 0));
  if (admin) return { id: "admin", name: "Admin", daily: 0, perMinute: ADMIN_PER_MINUTE, paid: false, expires_at: null, unlimited: true, extra: left };
  const plan = activePlan(id, expiresAt);
  const paid = plan.price > 0;
  return { id: plan.id, name: plan.name, daily: plan.daily, perMinute: plan.perMinute, paid, expires_at: paid ? (expiresAt ?? null) : null, unlimited: plan.unlimited === true, extra: left };
}

const nf = new Intl.NumberFormat("id-ID");
export const formatNumber = (n: number) => nf.format(n);
export const rupiah = (n: number) => `Rp${nf.format(n)}`;
