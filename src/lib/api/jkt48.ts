import { load } from "cheerio";
import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { need, opt } from "./helpers";
import { cleanSlug } from "./scrape";
import { proxyConfigured, viaProxy } from "./filmproxy";

/*
 * Sumber: https://jkt48.com (situs resmi, versi 2025+).
 * Halaman HTML-nya dijaga tantangan Cloudflare, jadi yang dibaca adalah API JSON
 * publik yang dipakai situs itu sendiri (/api/v1/...), dengan header yang sama
 * seperti yang dikirim halamannya (X-Request-Id). Hanya endpoint tanpa login.
 *
 * jkt48.com menolak IP server Vercel walau headernya sama, tetapi menerima Supabase
 * Edge Function. Jadi bila perantara "sanka" (supabase/functions/film-proxy) sudah
 * diatur, panggilan dititipkan lewat sana; tanpa itu dipanggil langsung.
 */
const SITE = "https://jkt48.com";
const API = `${SITE}/api/v1`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const numv = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const notNull = <T>(v: T | null): v is T => v !== null;

/* ------------------------------------------------------------ pengambilan */

const MIN = 60_000;
const MAX_PER_MINUTE = 60;
const cache = new Map<string, { at: number; ttl: number; data: J }>();
const inflight = new Map<string, Promise<J>>();
const calls: number[] = [];

type GetOpt = {
  ttl: number;
  what: string;
  /** Halaman detail: sumber menjawab 400/404 untuk id yang tidak dikenal. */
  detail?: boolean;
  /** Bagian dari pengambilan massal (ulang tahun); tidak dihitung pembatas per menit. */
  bulk?: boolean;
};

async function jktGet(path: string, query: Record<string, string | number | undefined>, o: GetOpt): Promise<J> {
  const qs = new URLSearchParams({ lang: "id" });
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const key = `${path}?${qs}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.data;
  const running = inflight.get(key);
  if (running) return running;

  if (!o.bulk) {
    while (calls.length && now - calls[0] > MIN) calls.shift();
    if (calls.length >= MAX_PER_MINUTE) throw new HttpError(429, "Permintaan ke jkt48.com sedang padat. Coba lagi sekitar satu menit lagi.");
    calls.push(now);
  }

  const job = (async () => {
    const url = `${API}${key}`;
    const accept = "application/json, text/plain, */*";
    let status: number;
    let type: string;
    let text: string;
    if (proxyConfigured("sanka")) {
      const r = await viaProxy(url, { via: "sanka", label: "Server perantara JKT48", accept, referer: `${SITE}/`, requestId: true, timeoutMs: 20000 });
      ({ status, type, text } = r);
    } else {
      let res: Response;
      try {
        res = await fetch(url, {
          cache: "no-store",
          redirect: "follow",
          signal: AbortSignal.timeout(12000),
          headers: { "user-agent": UA, accept, "accept-language": "id-ID,id;q=0.9,en;q=0.8", referer: `${SITE}/`, "x-request-id": crypto.randomUUID() },
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (name === "TimeoutError" || name === "AbortError") throw new HttpError(504, "jkt48.com terlalu lama merespons.");
        throw new HttpError(502, "Gagal menghubungi jkt48.com.");
      }
      status = res.status;
      type = res.headers.get("content-type") ?? "";
      text = await res.text();
    }
    const ok = status >= 200 && status < 300;
    if (/^\s*</.test(text) || !/json/i.test(type)) {
      throw new HttpError(502, `jkt48.com menolak permintaan dari server ini (HTTP ${status}, perlindungan anti-bot). Coba lagi beberapa saat lagi.`);
    }
    let body: J;
    try {
      body = obj(JSON.parse(text));
    } catch {
      throw new HttpError(502, "jkt48.com mengirim respons yang tidak valid.");
    }
    if (!ok || body.status === false) {
      if (status === 429) throw new HttpError(429, "jkt48.com sedang membatasi permintaan. Coba lagi sebentar lagi.");
      if (o.detail && (status === 400 || status === 404)) throw new HttpError(404, `${o.what} tidak ditemukan di jkt48.com.`);
      const msg = Array.isArray(body.message) ? body.message.map(String).join("; ") : str(body.message);
      if (status >= 500) throw new HttpError(502, `jkt48.com sedang bermasalah (HTTP ${status}).`);
      throw new HttpError(502, `jkt48.com menolak permintaan (HTTP ${status})${msg ? `: ${msg}` : "."}`);
    }
    if (cache.size >= 500) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), ttl: o.ttl, data: body });
    return body;
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/** Bilangan bulat dalam rentang; di luar rentang ditolak, bukan dibulatkan diam-diam. */
function intParam(sp: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = sp.get(name)?.trim();
  if (!raw) return fallback;
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new HttpError(400, `Parameter '${name}' harus angka ${min} sampai ${max}.`);
  return Number(raw);
}

/** Jalankan `fn` untuk tiap item dengan paling banyak `limit` proses sekaligus. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ------------------------------------------------------- tanggal dan teks */

const WIB = 7 * 3600_000;
const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Tanggal hari ini menurut WIB (YYYY-MM-DD). */
const todayWib = () => isoDay(Date.now() + WIB);
const dayMs = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Sumber menyimpan tanggal sebagai tengah malam WIB dalam UTC ("…T17:00:00.000Z"). */
function wibDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isFinite(t) ? isoDay(t + WIB) : null;
}

function dateText(iso: string | null): string | null {
  if (!iso) return null;
  return `${Number(iso.slice(8, 10))} ${BULAN[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

const dayName = (iso: string | null): string | null => (iso ? HARI[new Date(dayMs(iso)).getUTCDay()] : null);
const clock = (v: unknown): string | null => {
  const m = /^(\d{2}:\d{2})/.exec(str(v) ?? "");
  return m ? m[1] : null;
};

/** HTML isi berita menjadi teks biasa dengan baris baru antar paragraf. */
function htmlToText(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  if (!/[<&]/.test(raw)) return raw;
  const marked = raw
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/\s*(p|div|h[1-6]|tr|ul|ol|table|blockquote)\s*>/gi, "\n\n");
  const text = load(`<div id="x">${marked}</div>`)("#x").text();
  return (
    text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || null
  );
}

function media(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `${API}/storages/${s.replace(/^\/+/, "")}`;
}

const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/* ------------------------------------------------------------------ member */

const TEAMS: Record<string, string> = {
  JKT48: "JKT48",
  LOVE: "Team Love",
  DREAM: "Team Dream",
  PASSION: "Team Passion",
  TRAINEE: "Trainee",
  JKT48_VIRTUAL: "JKT48 Virtual",
};
const TEAM_ORDER = Object.keys(TEAMS);
const TEAM_FILTER: Record<string, string> = { love: "LOVE", dream: "DREAM", passion: "PASSION", trainee: "TRAINEE", virtual: "JKT48_VIRTUAL" };

const teamName = (v: unknown): string | null => {
  const code = str(v);
  return code ? (TEAMS[code.toUpperCase()] ?? code) : null;
};
const memberStatus = (code: string | null) => (code === "TRAINEE" ? "Trainee" : code === "JKT48_VIRTUAL" ? "Virtual" : "Reguler");
const memberSlug = (name: string, id: number) => `${slugify(name)}-${id}`;
const memberUrl = (name: string, id: number) => `${SITE}/member/detail?member=${memberSlug(name, id)}`;

type Member = {
  id: number;
  slug: string;
  name: string;
  nickname: string | null;
  team: string | null;
  team_code: string | null;
  status: string;
  photo: string | null;
  url: string;
};

async function allMembers(): Promise<Member[]> {
  const body = await jktGet("/members", {}, { ttl: 30 * MIN, what: "Daftar member" });
  const list = arr(body.data)
    .map((v): Member | null => {
      const m = obj(v);
      const id = numv(m.jkt48_member_id);
      const name = str(m.name);
      if (id === null || !name) return null;
      const code = str(m.type)?.toUpperCase() ?? null;
      return {
        id,
        slug: memberSlug(name, id),
        name,
        nickname: str(m.nickname),
        team: teamName(code),
        team_code: code,
        status: memberStatus(code),
        photo: media(m.photo),
        url: memberUrl(name, id),
      };
    })
    .filter(notNull);
  if (!list.length) throw new HttpError(502, "Daftar member dari jkt48.com kosong atau formatnya berubah.");
  const rank = (m: Member) => {
    const i = TEAM_ORDER.indexOf(m.team_code ?? "");
    return i < 0 ? TEAM_ORDER.length : i;
  };
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function ageOn(birth: string, today: string): number {
  let age = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
  if (today.slice(5) < birth.slice(5)) age--;
  return age;
}

/** Ulang tahun pada tahun tertentu; 29 Februari dirayakan 28 Februari di tahun biasa. */
function birthdayIn(year: number, month: number, day: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return Date.UTC(year, month - 1, month === 2 && day === 29 && !leap ? 28 : day);
}

const social = (v: unknown, base: string): string | null => {
  const s = str(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `${base}${s.replace(/^@/, "")}`;
};

async function memberProfile(id: number, bulk = false) {
  const body = await jktGet(`/members/${id}`, {}, { ttl: 12 * 60 * MIN, what: "Member", detail: true, bulk });
  const d = obj(body.data);
  const name = str(d.name);
  if (!name) throw new HttpError(404, "Member tidak ditemukan di jkt48.com.");
  const code = str(d.type)?.toUpperCase() ?? null;
  const birth = wibDate(d.birth_date);
  const photos = [d.photo_1, d.photo_2, d.photo_3, d.photo].map(media).filter(notNull);
  return {
    id,
    slug: memberSlug(name, id),
    name,
    nickname: str(d.nickname),
    team: teamName(code),
    team_code: code,
    status: memberStatus(code),
    birthday: birth,
    birthday_text: dateText(birth),
    age: birth ? ageOn(birth, todayWib()) : null,
    birth_place: str(d.birth_place),
    blood_type: str(d.blood_type),
    height_cm: numv(d.body_height),
    zodiac: str(d.horoscope),
    socials: {
      twitter: social(d.twitter_account, "https://x.com/"),
      instagram: social(d.instagram_account, "https://www.instagram.com/"),
      tiktok: social(d.tiktok_account, "https://www.tiktok.com/@"),
    },
    profile_video: str(d.youtube_profile_movie),
    photo: photos[0] ?? null,
    photos: [...new Set(photos)],
    url: memberUrl(name, id),
  };
}

/** Terima id angka (31), slug situs (aurellia-31), URL jkt48.com, atau nama/panggilan. */
async function resolveMemberId(raw: string): Promise<number> {
  let v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      v = u.searchParams.get("member") ?? u.pathname.split("/").filter(Boolean).pop() ?? "";
    } catch {
      throw new HttpError(400, "Parameter 'id' bukan URL yang valid.");
    }
  }
  if (/^\d{1,6}$/.test(v)) return Number(v);
  const tail = /-(\d{1,6})$/.exec(v);
  if (tail) return Number(tail[1]);

  const key = slugify(v);
  if (!key) throw new HttpError(400, "Parameter 'id' tidak valid. Isi id angka, slug (aurellia-31), atau nama member.");
  const list = await allMembers();
  const exact = list.filter((m) => slugify(m.name) === key || (m.nickname && slugify(m.nickname) === key));
  const found = exact.length ? exact : list.filter((m) => slugify(m.name).split("-").includes(key) || slugify(m.name).startsWith(key));
  if (!found.length) throw new HttpError(404, `Member '${v}' tidak ditemukan. Lihat daftar id di /api/jkt48/member.`);
  if (found.length > 1) {
    throw new HttpError(400, `Nama '${v}' cocok dengan beberapa member: ${found.map((m) => `${m.name} (id ${m.id})`).join(", ")}. Pakai id-nya.`);
  }
  return found[0].id;
}

/* ------------------------------------------------------------------ jadwal */

const TYPES = ["show", "event", "exclusive", "general"];

type Schedule = {
  id: string;
  code: string | null;
  title: string;
  type: string | null;
  team: string | null;
  date: string | null;
  day: string | null;
  start: string | null;
  end: string | null;
  time: string | null;
  birthday: boolean;
  description: string | null;
  url: string;
};

const timeText = (start: string | null, end: string | null) => (start ? `${start}${end ? ` - ${end}` : ""} WIB` : null);

async function monthSchedule(year: number, month: number): Promise<Schedule[]> {
  const body = await jktGet("/schedules", { month: String(month).padStart(2, "0"), year }, { ttl: 5 * MIN, what: "Jadwal" });
  return arr(body.data)
    .map((v): Schedule | null => {
      const s = obj(v);
      const id = str(s.link);
      const title = str(s.title);
      if (!id || !title) return null;
      const date = wibDate(s.date);
      const start = clock(s.start_time);
      const end = clock(s.end_time);
      return {
        id,
        code: str(s.reference_code),
        title,
        type: str(s.type)?.toLowerCase() ?? null,
        team: teamName(s.jkt48_member_type),
        date,
        day: dayName(date),
        start,
        end,
        time: timeText(start, end),
        birthday: Boolean(str(s.birthday_member)),
        description: htmlToText(s.content_body) ?? htmlToText(s.short_description),
        url: str(s.external_url) ?? `${SITE}/schedule/${id}`,
      };
    })
    .filter(notNull)
    .sort((a, b) => `${a.date ?? ""} ${a.start ?? ""}`.localeCompare(`${b.date ?? ""} ${b.start ?? ""}`));
}

function scheduleSlug(raw: string): string {
  let v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      v = new URL(v).pathname.split("/").filter(Boolean).pop() ?? "";
    } catch {
      throw new HttpError(400, "Parameter 'id' bukan URL yang valid.");
    }
  }
  return cleanSlug(v, "id");
}

async function scheduleDetail(id: string) {
  const body = await jktGet(`/schedules/${encodeURIComponent(id)}`, {}, { ttl: 5 * MIN, what: "Jadwal", detail: true });
  const d = obj(body.data);
  const title = str(d.title);
  if (!title) throw new HttpError(404, "Jadwal tidak ditemukan di jkt48.com.");
  const code = str(d.code);
  const sessions = arr(d.session).map((v) => {
    const s = obj(v);
    const date = wibDate(s.date);
    return {
      label: str(s.label),
      date,
      day: dayName(date),
      start: clock(s.start_time),
      end: clock(s.end_time),
      lanes: arr(s.session_detail).map((x) => {
        const l = obj(x);
        return { label: str(l.label), member: str(l.jkt48_member_name), available: l.quota_available === true };
      }),
    };
  });
  const probe = (code ?? id).toUpperCase();
  const type = sessions.length || str(d.category) || probe.startsWith("EX") ? "exclusive" : probe.startsWith("SH") ? "show" : probe.startsWith("EV") ? "event" : "general";
  const date = wibDate(d.date) ?? sessions[0]?.date ?? null;
  const start = clock(d.start_time);
  const end = clock(d.end_time);
  const seitansai = arr(d.birthday_member_name).map(str).filter(notNull);
  return {
    id,
    code,
    title,
    type,
    category: str(d.category),
    team: teamName(d.jkt48_member_type),
    date,
    day: dayName(date),
    start,
    end,
    time: timeText(start, end),
    doors_open: clock(d.reception_start_time),
    in_theater: typeof d.is_in_theater === "boolean" ? d.is_in_theater : type === "show" ? true : null,
    price: numv(d.default_price),
    max_purchase: numv(d.max_purchase),
    birthday: Boolean(str(d.birthday_member)) || seitansai.length > 0,
    seitansai,
    lineup: arr(d.jkt48_member)
      .map((v) => {
        const m = obj(v);
        const name = str(m.name);
        return name ? { id: numv(m.member_id), name, team: teamName(m.type) } : null;
      })
      .filter(notNull),
    description: htmlToText(d.content_body) ?? htmlToText(d.short_description),
    image: media(d.background_image) ?? media(d.preview_image) ?? media(d.thumbnail_image),
    sales: arr(d.sales_period).map((v) => {
      const p = obj(v);
      return {
        label: str(p.label),
        start: str(p.start_date),
        end: str(p.end_date),
        method: str(p.sales_method)?.toLowerCase() ?? null,
        prices: arr(p.pricing).map((x) => {
          const r = obj(x);
          return { label: str(r.label), price: numv(r.price), ofc_only: r.is_ofc_only === true };
        }),
      };
    }),
    sessions,
    ticket_url: str(d.external_ticketing_url),
    url: `${SITE}/schedule/${id}`,
  };
}

/* ------------------------------------------------------------------ berita */

function newsSlug(raw: string): string {
  let v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      v = new URL(v).pathname.split("/").filter(Boolean).pop() ?? "";
    } catch {
      throw new HttpError(400, "Parameter 'id' bukan URL yang valid.");
    }
  }
  return cleanSlug(v, "id");
}

function newsCard(v: unknown) {
  const n = obj(v);
  const id = str(n.link);
  const title = str(n.title);
  if (!id || !title) return null;
  const date = wibDate(n.valid_date_from);
  return {
    id,
    title,
    category: str(n.category),
    date,
    date_text: dateText(date),
    image: media(n.background_image),
    url: str(n.external_url) ?? `${SITE}/news/${id}`,
  };
}

/* ---------------------------------------------------------------- endpoint */

export const jkt48Endpoints: Endpoint[] = [
  {
    category: "jkt48", slug: "member", kind: "json",
    title: "Daftar Member",
    description: "Semua member JKT48 dari situs resmi jkt48.com: nama, panggilan, tim, status, dan foto. Bisa disaring per tim.",
    params: [{ name: "tim", description: "Saring per tim. Kosongkan untuk semua member.", example: "", options: ["love", "dream", "passion", "trainee"] }],
    handler: async ({ sp }) => {
      const tim = opt(sp, "tim").toLowerCase().replace(/^team[\s_-]*/, "");
      if (tim && !TEAM_FILTER[tim]) throw new HttpError(400, "Parameter 'tim' harus love, dream, passion, atau trainee.");
      const all = await allMembers();
      const members = tim ? all.filter((m) => m.team_code === TEAM_FILTER[tim]) : all;
      const teams: Record<string, number> = {};
      for (const m of all) if (m.team) teams[m.team] = (teams[m.team] ?? 0) + 1;
      return { source: SITE, total: members.length, teams, members };
    },
  },
  {
    category: "jkt48", slug: "member-detail", kind: "json",
    title: "Profil Member",
    description: "Profil satu member JKT48: tanggal lahir, umur, golongan darah, tinggi badan, zodiak, akun media sosial, dan foto.",
    params: [{ name: "id", required: true, description: "Id member (31), slug (aurellia-31), URL profil di jkt48.com, atau nama/panggilan (freya).", example: "freya" }],
    handler: async ({ sp }) => {
      const id = await resolveMemberId(need(sp, "id", 300));
      return { source: SITE, ...(await memberProfile(id)) };
    },
  },
  {
    category: "jkt48", slug: "schedule", kind: "json",
    title: "Jadwal Bulanan",
    description: "Semua jadwal JKT48 dalam satu bulan: show theater, event, dan kegiatan lain, lengkap dengan tanggal, jam (WIB), tim, dan penanda show ulang tahun.",
    params: [
      { name: "bulan", description: "Bulan 1 sampai 12. Kosongkan untuk bulan ini.", example: "" },
      { name: "tahun", description: "Tahun, misalnya 2026. Kosongkan untuk tahun ini.", example: "" },
      { name: "tipe", description: "Saring jenis jadwal. Kosongkan untuk semua.", example: "", options: TYPES },
    ],
    handler: async ({ sp }) => {
      const today = todayWib();
      const month = intParam(sp, "bulan", Number(today.slice(5, 7)), 1, 12);
      const year = intParam(sp, "tahun", Number(today.slice(0, 4)), 2011, 2100);
      const tipe = opt(sp, "tipe").toLowerCase();
      if (tipe && !TYPES.includes(tipe)) throw new HttpError(400, `Parameter 'tipe' harus salah satu dari: ${TYPES.join(", ")}.`);
      const all = await monthSchedule(year, month);
      const schedules = tipe ? all.filter((s) => s.type === tipe) : all;
      return { source: SITE, period: `${BULAN[month - 1]} ${year}`, month, year, total: schedules.length, schedules };
    },
  },
  {
    category: "jkt48", slug: "schedule-detail", kind: "json",
    title: "Detail Jadwal",
    description: "Detail satu jadwal: member yang tampil (lineup), member yang berulang tahun (seitansai), harga tiket, masa penjualan, dan sesi untuk acara eksklusif.",
    params: [{ name: "id", required: true, description: "Nilai 'id' dari endpoint schedule atau theater, atau URL jadwal di jkt48.com.", example: "shc218-itadakilove" }],
    handler: async ({ sp }) => ({ source: SITE, ...(await scheduleDetail(scheduleSlug(need(sp, "id", 400)))) }),
  },
  {
    category: "jkt48", slug: "theater", kind: "json",
    title: "Jadwal Theater Terdekat",
    description: "Show theater JKT48 mulai hari ini: setlist, tanggal, jam, tim, lineup member, dan member yang seitansai.",
    params: [{ name: "limit", description: "Jumlah show, 1 sampai 10.", example: "5" }],
    handler: async ({ sp }) => {
      const limit = intParam(sp, "limit", 5, 1, 10);
      const today = todayWib();
      const y = Number(today.slice(0, 4));
      const m = Number(today.slice(5, 7));
      const upcoming = (list: Schedule[]) => list.filter((s) => s.type === "show" && (s.date ?? "") >= today);
      let shows = upcoming(await monthSchedule(y, m));
      if (shows.length < limit) shows = shows.concat(upcoming(await monthSchedule(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1)));
      shows = shows.slice(0, limit);
      const items = await mapLimit(shows, 4, async (s) => {
        const d = await scheduleDetail(s.id).catch(() => null);
        return {
          id: s.id,
          setlist: s.title,
          team: s.team,
          date: s.date,
          day: s.day,
          time: s.time,
          doors_open: d?.doors_open ?? null,
          price: d?.price ?? null,
          birthday: d?.birthday ?? s.birthday,
          seitansai: d?.seitansai ?? [],
          lineup: d ? d.lineup.map((x) => x.name) : null,
          url: s.url,
        };
      });
      return { source: SITE, today, total: items.length, shows: items };
    },
  },
  {
    category: "jkt48", slug: "news", kind: "json",
    title: "Berita Terbaru",
    description: "Pengumuman dan berita resmi JKT48, terbaru lebih dulu, dengan paginasi.",
    params: [
      { name: "page", description: "Halaman, mulai dari 1.", example: "1" },
      { name: "limit", description: "Jumlah berita per halaman, 1 sampai 30.", example: "10" },
    ],
    handler: async ({ sp }) => {
      const page = intParam(sp, "page", 1, 1, 5000);
      const limit = intParam(sp, "limit", 10, 1, 30);
      const body = await jktGet("/news", { page, limit }, { ttl: 5 * MIN, what: "Berita" });
      const meta = obj(body._meta);
      const news = arr(body.data).map(newsCard).filter(notNull);
      const totalPages = numv(meta.total_page) ?? page;
      if (!news.length && page > 1 && page > totalPages) throw new HttpError(404, `Halaman ${page} tidak ada. Halaman terakhir: ${totalPages}.`);
      return { source: SITE, page, total_pages: totalPages, total_news: numv(meta.count_total), total: news.length, news };
    },
  },
  {
    category: "jkt48", slug: "news-detail", kind: "json",
    title: "Isi Berita",
    description: "Isi lengkap satu berita JKT48 dalam bentuk teks dan HTML aslinya.",
    params: [{ name: "id", required: true, description: "Nilai 'id' dari endpoint news, atau URL berita di jkt48.com.", example: "pengumuman-mengenai-audisi-jkt48-generasi-ke-15" }],
    handler: async ({ sp }) => {
      const id = newsSlug(need(sp, "id", 400));
      const body = await jktGet(`/news/${encodeURIComponent(id)}`, {}, { ttl: 30 * MIN, what: "Berita", detail: true });
      const data = obj(body.data);
      const raw = obj(data.result ?? data);
      const card = newsCard({ ...raw, link: str(raw.link) ?? id });
      if (!card) throw new HttpError(404, "Berita tidak ditemukan di jkt48.com.");
      const html = str(raw.content_body);
      return { source: SITE, ...card, summary: htmlToText(raw.short_description), content: htmlToText(html), html: html && /</.test(html) ? html : null };
    },
  },
  {
    category: "jkt48", slug: "birthday", kind: "json",
    title: "Ulang Tahun Member",
    description: "Member JKT48 yang akan berulang tahun, diurutkan dari yang paling dekat: tanggal, umur yang akan dicapai, dan sisa hari. Bisa juga dilihat per bulan.",
    params: [
      { name: "limit", description: "Jumlah member, 1 sampai 100.", example: "10" },
      { name: "bulan", description: "Opsional: hanya member yang lahir di bulan ini (1 sampai 12).", example: "" },
    ],
    handler: async ({ sp }) => {
      const limit = intParam(sp, "limit", 10, 1, 100);
      const bulan = intParam(sp, "bulan", 0, 1, 12) || null;
      const list = await allMembers();
      const profiles = await mapLimit(list, 4, (m) => memberProfile(m.id, true).catch(() => null));
      const known = profiles.filter(notNull).filter((p) => p.birthday);
      if (known.length < list.length / 2) throw new HttpError(502, "Data tanggal lahir dari jkt48.com belum lengkap terbaca. Coba lagi sebentar lagi.");
      const today = todayWib();
      const todayMs = dayMs(today);
      let items = known.map((p) => {
        const birth = p.birthday as string;
        const mm = Number(birth.slice(5, 7));
        const dd = Number(birth.slice(8, 10));
        let year = Number(today.slice(0, 4));
        let next = birthdayIn(year, mm, dd);
        if (next < todayMs) next = birthdayIn(++year, mm, dd);
        const date = isoDay(next);
        return {
          id: p.id,
          name: p.name,
          nickname: p.nickname,
          team: p.team,
          status: p.status,
          birthday: birth,
          next_birthday: date,
          next_birthday_text: `${dayName(date)}, ${dateText(date)}`,
          turning: year - Number(birth.slice(0, 4)),
          days_left: Math.round((next - todayMs) / 86_400_000),
          is_today: next === todayMs,
          photo: p.photo,
          url: p.url,
        };
      });
      if (bulan) items = items.filter((i) => Number(i.birthday.slice(5, 7)) === bulan).sort((a, b) => a.birthday.slice(8).localeCompare(b.birthday.slice(8)) || a.name.localeCompare(b.name));
      else items.sort((a, b) => a.days_left - b.days_left || a.name.localeCompare(b.name));
      items = items.slice(0, limit);
      return { source: SITE, today, ...(bulan ? { month: BULAN[bulan - 1] } : {}), members_read: known.length, total: items.length, birthdays: items };
    },
  },
];
