import { after } from "next/server";
import { getStore, type ApiBlock } from "@/db/store";
import { categories } from "@/lib/api/categories";
import { endpoints, findEndpoint } from "@/lib/api/registry";

/**
 * Blokir API: admin bisa menonaktifkan satu endpoint, atau satu kategori penuh, tanpa deploy ulang
 * (misalnya saat sumber datanya sedang rusak). Permintaan ke endpoint yang diblokir dijawab 503
 * dan tidak mengurangi kuota harian.
 *
 *  - Sasaran ditulis "kategori/slug" (mis. "film/lk21") atau "kategori/*" (mis. "film/*").
 *  - Daftarnya disimpan di tabel `blocked_endpoints` supaya berlaku di semua instance serverless,
 *    dan dibaca ulang paling lama setiap 30 detik. Tanpa database, blokir hanya hidup di memori instance.
 *  - Kelola lewat halaman /admin, atau /api/admin/apiblocks, apiblock, apiunblock.
 */
export type { ApiBlock };

const REFRESH_MS = 30_000;

type State = { blocks: Map<string, ApiBlock>; loadedAt: number; loading: Promise<void> | null };

const g = globalThis as typeof globalThis & { __yanxzBlocks?: State };
const state: State = (g.__yanxzBlocks ??= { blocks: new Map(), loadedAt: 0, loading: null });

const setAll = (rows: ApiBlock[]) => {
  state.blocks = new Map(rows.map((r) => [r.path, r] as const));
  state.loadedAt = Date.now();
};

function refresh(): Promise<void> {
  const store = getStore();
  if (!store) return Promise.resolve();
  state.loading ??= store
    .listBlocks()
    .then(setAll)
    .catch(() => {
      /* database tidak bisa dihubungi: pakai data terakhir, lalu coba lagi lebih cepat */
      state.loadedAt = Date.now() - REFRESH_MS / 2;
    })
    .finally(() => {
      state.loading = null;
    });
  return state.loading;
}

async function ensure() {
  if (state.loadedAt === 0) {
    await refresh();
  } else if (Date.now() - state.loadedAt > REFRESH_MS && !state.loading) {
    const task = () => refresh();
    try {
      after(task);
    } catch {
      void task();
    }
  }
}

/** Blokir yang berlaku untuk endpoint `key` ("kategori/slug"): miliknya sendiri, atau milik kategorinya. */
export async function endpointBlock(key: string): Promise<ApiBlock | null> {
  await ensure();
  if (state.blocks.size === 0) return null;
  return state.blocks.get(key) ?? state.blocks.get(`${key.split("/")[0]}/*`) ?? null;
}

/** Semua blokir yang sedang berlaku (dari cache), terbaru lebih dulu. */
export async function activeBlocks(): Promise<ApiBlock[]> {
  await ensure();
  return [...state.blocks.values()];
}

const TARGET_RE = /^[a-z0-9-]{1,40}\/(\*|[a-z0-9-]{1,70})$/;

/**
 * Rapikan sasaran blokir yang diketik admin menjadi "kategori/slug" atau "kategori/*".
 * Menerima juga tautan lengkap, awalan "/api/", dan nama kategori saja. null bila bentuknya salah.
 */
export function normalizeTarget(raw: string | null | undefined): string | null {
  let s = (raw || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "").replace(/^\/+/, "").replace(/^api\//, "").replace(/\/+$/, "");
  if (s && !s.includes("/")) s = `${s}/*`;
  return TARGET_RE.test(s) ? s : null;
}

/** Sasaran menunjuk endpoint atau kategori yang benar-benar ada. */
export function targetExists(target: string): boolean {
  const [cat, slug] = target.split("/");
  return slug === "*" ? endpoints.some((e) => e.category === cat) : !!findEndpoint(target);
}

/** Keterangan sasaran untuk ditampilkan: judul endpoint, atau nama kategorinya. */
export function describeTarget(target: string): { scope: "endpoint" | "category"; title: string; exists: boolean } {
  const [cat, slug] = target.split("/");
  if (slug === "*") {
    const c = categories.find((x) => x.id === cat);
    return { scope: "category", title: `Semua endpoint ${c?.name ?? cat}`, exists: targetExists(target) };
  }
  const e = findEndpoint(target);
  return { scope: "endpoint", title: e?.title ?? "", exists: !!e };
}

/* ---------- dipakai endpoint admin ---------- */

export async function adminBlockApi(target: string, reason: string) {
  const row: ApiBlock = { path: target, reason: reason.slice(0, 300), created_at: new Date().toISOString() };
  await getStore()?.blockPath(row.path, row.reason);
  // Bila daftar belum pernah dimuat di instance ini, `loadedAt` tetap 0 sehingga permintaan berikutnya memuat daftar lengkapnya.
  state.blocks.set(row.path, row);
}

/** Mengembalikan false bila sasaran itu memang tidak sedang diblokir. */
export async function adminUnblockApi(target: string): Promise<boolean> {
  const rows = await adminListBlocks();
  if (!rows.some((r) => r.path === target)) return false;
  await getStore()?.unblockPath(target);
  state.blocks.delete(target);
  return true;
}

export async function adminListBlocks(): Promise<ApiBlock[]> {
  const store = getStore();
  if (store) setAll(await store.listBlocks());
  return [...state.blocks.values()];
}
