import { ADMIN_PER_MINUTE, FREE_PLAN, activePlan, type Plan } from "@/lib/plans";
import { KEY_RE } from "./keys";
import { keyOwner } from "./users";

/*
  Pemeriksaan API key untuk setiap permintaan ke /api/<kategori>/<endpoint>.
  Hasilnya di-cache di memori tiap instance supaya tidak ada satu panggilan database per
  permintaan. Akibatnya key yang diganti atau akun yang dinonaktifkan bisa masih diterima
  paling lama VALID_TTL_MS di instance lain.

  Cache yang sama menyimpan paket pemilik key dan pemakaiannya hari ini, untuk kuota harian.
  Angka pemakaian dibaca dari database tiap VALID_TTL_MS dan di antaranya dihitung di memori,
  jadi kuota ditegakkan dengan toleransi kecil bila beberapa instance berjalan bersamaan.
*/
const VALID_TTL_MS = 60_000;
const INVALID_TTL_MS = 30_000;
const MAX_ENTRIES = 20_000;

export type KeyVerdict = "ok" | "invalid" | "banned" | "error";
type Entry = {
  verdict: Exclude<KeyVerdict, "error">;
  id: string | null;
  exp: number;
  /** Id paket di database dan akhir masa aktifnya (ms; 0 bila tidak ada). */
  plan: string;
  planExp: number;
  /** Akun admin: tanpa kuota harian, batas per menitnya dihitung per akun. */
  admin: boolean;
  /** Permintaan yang sudah dipakai pada hari `day` (nomor hari menurut WIB). */
  used: number;
  day: number;
};

const WIB_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
/** Nomor hari menurut WIB; berganti tepat pukul 00.00 WIB, sama seperti tabel api_usage. */
const wibDay = (now: number) => Math.floor((now + WIB_MS) / DAY_MS);

const g = globalThis as typeof globalThis & { __yanzKeys?: Map<string, Entry> };
const cache = (g.__yanzKeys ??= new Map());

/** Ambil API key dari query (?apikey=) atau header (x-api-key, Authorization: Bearer). */
export function keyFromRequest(req: Request, sp: URLSearchParams): string {
  const fromQuery = sp.get("apikey") ?? sp.get("api_key");
  if (fromQuery) return fromQuery.trim();
  const header = req.headers.get("x-api-key");
  if (header) return header.trim();
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
  return bearer ? bearer[1] : "";
}

export async function verifyKey(key: string): Promise<KeyVerdict> {
  if (!KEY_RE.test(key)) return "invalid";
  const now = Date.now();
  const hit = cache.get(key);
  // Lewat tengah malam WIB angka pemakaian di cache sudah tidak berlaku, jadi dibaca ulang.
  if (hit && hit.exp > now && hit.day === wibDay(now)) return hit.verdict;
  let verdict: Entry["verdict"];
  let id: string | null = null;
  let plan = "free";
  let planExp = 0;
  let used = 0;
  let admin = false;
  try {
    const owner = await keyOwner(key);
    verdict = !owner ? "invalid" : owner.banned ? "banned" : "ok";
    id = owner?.id ?? null;
    plan = owner?.plan || "free";
    planExp = owner?.plan_expires_at ? Date.parse(owner.plan_expires_at) || 0 : 0;
    used = Math.max(0, Math.floor(Number(owner?.used_today) || 0));
    admin = owner?.is_admin === true;
  } catch {
    // Database tidak bisa dihubungi: pakai jawaban terakhir bila ada, selain itu tolak dulu.
    return hit ? hit.verdict : "error";
  }
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
    if (cache.size >= MAX_ENTRIES) cache.clear();
  }
  cache.set(key, { verdict, id, exp: now + (verdict === "ok" ? VALID_TTL_MS : INVALID_TTL_MS), plan, planExp, admin, used, day: wibDay(now) });
  return verdict;
}

/** Paket yang berlaku untuk sebuah key menurut cache; gratis bila key belum dikenal di instance ini. */
function cachedPlan(key: string, now: number): Plan {
  const hit = cache.get(key);
  return hit && hit.verdict === "ok" ? activePlan(hit.plan, hit.planExp, now) : FREE_PLAN;
}

/** Key ini sudah pernah diperiksa di instance ini (apa pun hasilnya), jadi paketnya sudah diketahui. */
export function keyKnown(key: string): boolean {
  return !KEY_RE.test(key) || cache.has(key);
}

/**
 * Untuk pembatas per menit, dipakai sebelum key diperiksa ke database: akun paket berbayar
 * dan akun admin dihitung per akun dengan batasnya sendiri, bukan per IP. null untuk paket gratis dan untuk key
 * yang belum dikenal di instance ini (termasuk tebakan), yang tetap dihitung per IP.
 */
export function keyPaid(key: string): { id: string; limit: number; name: string } | null {
  const hit = key ? cache.get(key) : undefined;
  if (!hit || hit.verdict !== "ok" || !hit.id) return null;
  if (hit.admin) return { id: hit.id, limit: ADMIN_PER_MINUTE, name: "Admin" };
  const plan = activePlan(hit.plan, hit.planExp);
  return plan.price > 0 ? { id: hit.id, limit: plan.perMinute, name: plan.name } : null;
}

export type KeyQuota = { plan: Plan; used: number; left: number; /** Detik sampai kuota terisi lagi (00.00 WIB). */ resetIn: number; /** Akun admin: kuota harian tidak berlaku. */ unlimited: boolean };

/** Kuota harian sebuah key yang baru saja lolos `verifyKey`. */
export function keyQuota(key: string): KeyQuota {
  const now = Date.now();
  const hit = cache.get(key);
  const plan = cachedPlan(key, now);
  const used = hit && hit.day === wibDay(now) ? hit.used : 0;
  return { plan, used, left: Math.max(0, plan.daily - used), unlimited: !!hit && hit.verdict === "ok" && hit.admin, resetIn: Math.max(1, Math.ceil(((wibDay(now) + 1) * DAY_MS - WIB_MS - now) / 1000)) };
}

/** Hitung satu permintaan ke kuota harian key ini (angka di database menyusul lewat recordUsage). */
export function keyUse(key: string) {
  const hit = cache.get(key);
  if (hit && hit.verdict === "ok") hit.used++;
}

/** Id akun pemilik sebuah key yang baru saja lolos `verifyKey` (dibaca dari cache), untuk statistik pemakaian. */
export function keyOwnerId(key: string): string | null {
  const hit = cache.get(key);
  return hit && hit.verdict === "ok" ? hit.id : null;
}

/** Lupakan sebuah key di instance ini (dipanggil saat key diganti). */
export function forgetKey(key: string) {
  cache.delete(key);
}

/** Kosongkan cache (dipanggil saat owner menonaktifkan / mengaktifkan akun). */
export function forgetAllKeys() {
  cache.clear();
}

/**
 * Sisipkan API key ke tautan dalam respons yang menunjuk ke API ini sendiri (mis. `cek`,
 * `next`, proxy gambar komik, halaman player), supaya tautan itu tetap bisa langsung dipakai.
 * Key disisipkan tepat setelah `?` agar tautan yang sengaja dibiarkan terbuka di ujungnya
 * (`...&jawaban=`) masih bisa disambung.
 */
export function withKeyInLinks<T>(value: T, origin: string, key: string): T {
  const prefix = `${origin}/api/`;
  const param = `apikey=${encodeURIComponent(key)}`;
  const fix = (s: string): string => {
    if (!s.startsWith(prefix) || /[?&]apikey=/.test(s)) return s;
    const q = s.indexOf("?");
    if (q < 0) return `${s}?${param}`;
    return q === s.length - 1 ? `${s}${param}` : `${s.slice(0, q + 1)}${param}&${s.slice(q + 1)}`;
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return fix(v);
    if (depth > 12 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  return walk(value, 0) as T;
}

/** Sama seperti `withKeyInLinks`, untuk tautan di dalam halaman HTML (atribut href/src yang sudah di-escape). */
export function withKeyInHtml(html: string, origin: string, key: string): string {
  const prefix = `${origin}/api/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.replace(new RegExp(`${prefix}[A-Za-z0-9/_-]+\\?(?!apikey=)`, "g"), (m) => `${m}apikey=${encodeURIComponent(key)}&amp;`);
}
