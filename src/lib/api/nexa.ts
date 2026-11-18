import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { need, opt, parseHttpUrl } from "./helpers";

/*
  Endpoint publik NexaDev (api.nexadev.my.id). Tidak pakai kunci API, tapi
  layanannya membatasi 100 permintaan dan membalas 429 bila lewat, jadi galatnya
  diteruskan sebagai 429/502 supaya pemanggil tahu harus menunggu.
*/

const BASE = "https://api.nexadev.my.id";

type Nexa = { status?: boolean; message?: string; data?: unknown; error?: string; ok?: boolean };

async function getJson(path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; yanz.api/1.0)" },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new HttpError(502, "Server NexaDev tidak bisa dihubungi. Coba lagi nanti.");
  }
  const data = (await res.json().catch(() => null)) as Nexa | null;
  if (res.status === 429) {
    const wait = typeof (data as { retryAfterSec?: number } | null)?.retryAfterSec === "number" ? (data as { retryAfterSec: number }).retryAfterSec : null;
    throw new HttpError(429, `Batas 100 permintaan NexaDev sedang tercapai${wait ? `, coba lagi dalam ${wait} detik` : ""}.`);
  }
  if (!data) throw new HttpError(502, "Jawaban NexaDev tidak bisa dibaca.");
  if (!res.ok || data.status === false || data.ok === false) {
    const msg = data.message || data.error || "NexaDev menolak permintaan.";
    throw new HttpError(res.status === 400 || res.status === 404 ? 404 : 502, msg);
  }
  return data.data && typeof data.data === "object" ? (data.data as Record<string, unknown>) : (data as Record<string, unknown>);
}

/** Username TikTok/Instagram: huruf, angka, titik, garis bawah. */
function handle(sp: URLSearchParams, name: string): string {
  const raw = need(sp, name, 60).replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]{1,40}$/.test(raw)) throw new HttpError(400, `Parameter '${name}' harus username tanpa spasi.`);
  return raw;
}

export const nexaEndpoints: Endpoint[] = [
  {
    category: "tools",
    slug: "ml",
    kind: "json",
    aliases: ["mobile-legends"],
    title: "Cek Akun Mobile Legends",
    description: "Cek nama (nickname) dan region sebuah akun Mobile Legends dari User ID dan Zone ID yang dipakai saat login.",
    params: [
      { name: "id", required: true, description: "User ID akun Mobile Legends (angka).", example: "134972929" },
      { name: "zone", required: true, description: "Zone ID akun, biasanya 4 digit.", example: "2687" },
    ],
    handler: async ({ sp }) => {
      const id = need(sp, "id", 20);
      const zone = need(sp, "zone", 10);
      if (!/^\d{4,20}$/.test(id)) throw new HttpError(400, "Parameter 'id' harus berupa angka.");
      if (!/^\d{1,6}$/.test(zone)) throw new HttpError(400, "Parameter 'zone' harus berupa angka.");
      const data = await getJson("/api/ml/", { id, zone });
      return { id, zone, username: data.username ?? null, region: data.region ?? null };
    },
  },
  {
    category: "tools",
    slug: "roblox",
    kind: "json",
    title: "Profil Roblox",
    description: "Ambil profil publik sebuah akun Roblox: nama tampilan, avatar, bio, tanggal daftar, jumlah teman, pengikut, dan daftar game buatannya.",
    params: [{ name: "username", required: true, description: "Username Roblox.", example: "Linkmon99" }],
    handler: async ({ sp }) => {
      const data = await getJson("/api/roblox/", { username: handle(sp, "username") });
      const games = Array.isArray(data.games) ? (data.games as Record<string, unknown>[]) : [];
      return {
        id: data.id ?? null,
        username: data.name ?? null,
        display_name: data.displayName ?? null,
        description: data.description ?? null,
        avatar: data.avatar ?? null,
        created: data.created ?? null,
        verified: data.hasVerifiedBadge === true,
        banned: data.isBanned === true,
        friends: data.friends ?? null,
        followers: data.followers ?? null,
        followings: data.followings ?? null,
        badges: Array.isArray(data.badges) ? data.badges.length : 0,
        games: games.map((g) => ({
          name: g.name ?? null,
          visits: g.placeVisits ?? null,
          created: g.created ?? null,
          url: typeof g.id === "number" ? `https://www.roblox.com/games/${g.id}` : null,
        })),
      };
    },
  },
  {
    category: "tools",
    slug: "tiktok-stalker",
    kind: "json",
    aliases: ["tt-stalker"],
    title: "Info Akun TikTok",
    description: "Ambil data publik sebuah akun TikTok: nama, bio, foto profil, jumlah postingan, pengikut, mengikuti, dan total suka.",
    params: [{ name: "username", required: true, description: "Username TikTok tanpa '@'.", example: "nexadevv" }],
    handler: async ({ sp }) => {
      const data = await getJson("/api/tiktokstalker/", { username: handle(sp, "username") });
      return {
        id: data.id ?? null,
        username: data.username ?? null,
        name: data.name ?? null,
        bio: data.bio ?? null,
        photo: data.photo ?? null,
        posts: data.posts ?? null,
        followers: data.followers ?? null,
        following: data.following ?? null,
        likes: data.likes ?? null,
        verified: data.verified === true,
        private: data.private === true,
      };
    },
  },
  {
    category: "tools",
    slug: "instagram-stalker",
    kind: "json",
    aliases: ["ig-stalker"],
    title: "Info Akun Instagram",
    description: "Ambil data publik sebuah akun Instagram: nama, bio, foto profil, jumlah postingan, pengikut, mengikuti, dan status terverifikasi. Akun privat tetap bisa dilihat datanya, hanya isi postingannya yang tidak.",
    params: [{ name: "username", required: true, description: "Username Instagram tanpa '@'.", example: "instagram" }],
    handler: async ({ sp }) => {
      const data = await getJson("/api/instagramstalker/", { username: handle(sp, "username") });
      return {
        id: data.id ?? null,
        username: data.username ?? null,
        name: data.name ?? null,
        bio: data.bio ?? null,
        photo: data.photo ?? null,
        posts: data.posts ?? null,
        followers: data.followers ?? null,
        following: data.following ?? null,
        likes: data.likes ?? null,
        verified: data.verified === true,
        private: data.private === true,
      };
    },
  },
  {
    category: "image",
    slug: "wink",
    kind: "json",
    title: "Foto Jadi HD (Wink)",
    description:
      "Tingkatkan kualitas sebuah foto: wajah dipertajam dan dihaluskan oleh mesin BeautyPlus di balik layanan Wink. Kirim tautan langsung ke foto, hasilnya tautan gambar versi HD yang bisa langsung dipakai atau diunduh.",
    params: [
      {
        name: "url",
        required: true,
        description: "Tautan langsung ke foto (JPG atau PNG) yang bisa diakses publik, sebaiknya berisi wajah yang jelas.",
        example: "https://clooud.my.id/uploder/uploads/XIxbPP.jpg",
      },
    ],
    handler: async ({ sp }) => {
      const u = parseHttpUrl(need(sp, "url", 2000));
      const target = new URL("/api/wink/", BASE);
      target.searchParams.set("url", u.toString());
      // Nexa menyimpan hasil per URL, dan kegagalan lama ikut tersimpan. Endpoint ini
      // mengirim permintaan bersih; bila sumber sedang bermasalah, ulangi sekali.
      const attempt = async (): Promise<Response | null> => {
        try {
          return await fetch(target, {
            headers: {
              accept: "application/json, text/plain, */*",
              "accept-language": "id-ID,id;q=0.9",
              referer: `${BASE}/`,
              "user-agent":
                "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
            },
            cache: "no-store",
            signal: AbortSignal.timeout(45000),
          });
        } catch {
          return null;
        }
      };
      let res = await attempt();
      if (!res || !res.ok) {
        await new Promise((r) => setTimeout(r, 1200));
        res = (await attempt()) ?? res;
      }
      if (!res) throw new HttpError(502, "Server NexaDev tidak bisa dihubungi. Coba lagi nanti.");
      const data = (await res.json().catch(() => null)) as
        | { status?: boolean; message?: string; result?: string; resultUrl?: string; data?: { url?: string; mode?: string; engine?: string } }
        | null;
      if (res.status === 429) throw new HttpError(429, "Batas 100 permintaan NexaDev sedang tercapai. Coba lagi beberapa saat lagi.");
      const out = data?.resultUrl ?? data?.result ?? data?.data?.url;
      if (!res.ok || !data || data.status === false || typeof out !== "string" || !out) {
        throw new HttpError(
          res.status === 400 || res.status === 404 ? 400 : 502,
          data?.message || "Layanan sumber gagal memproses gambar itu. Coba foto lain yang wajahnya lebih jelas.",
        );
      }
      return { source: u.toString(), result: out, engine: data.data?.engine ?? null, mode: data.data?.mode ?? null };
    },
  },
];
