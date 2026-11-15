import type { Ctx, Endpoint, Upload } from "./types";
import { HttpError } from "./types";
import { need, num, opt, parseHttpUrl } from "./helpers";

/*
  Endpoint yang dikerjakan "worker": layanan di mesin sendiri (folder worker/ di repo ini,
  mis. di mesin Instabox) untuk tugas yang tidak bisa dijalankan di Vercel: Chromium, ffmpeg,
  dan model AI kecil. Env WORKER_URL + WORKER_KEY.

  Worker bisa mati kapan saja (mesin dijeda, sedang diperbarui). Karena itu setiap kegagalan
  menghubunginya dijawab 503 yang jelas, dan endpoint lain tidak bergantung padanya.
*/

const ENV_URL = "WORKER_URL";
const ENV_KEY = "WORKER_KEY";

/** Batas unggahan lewat yanz.api. Vercel menolak isi permintaan di atas 4,5 MB. */
const MAX_UPLOAD = 4 * 1024 * 1024;
const MAX_UPLOAD_MB = MAX_UPLOAD / 1024 / 1024;

const DOWN = "Server pengolah untuk fitur ini sedang tidak aktif. Coba lagi beberapa menit lagi.";
/**
 * Mesin worker yang dijeda (auto-pause) menjawab dengan halaman HTML dari gerbang, bukan JSON.
 * Kunjungan pertama sebenarnya membangunkan mesinnya; jawaban berikutnya sudah normal, jadi
 * permintaan diulang sekali setelah jeda singkat.
 */
const WAKE_RETRY_MS = 12_000;
const WAKING = "Server pengolah sedang dinyalakan. Tunggu sebentar lalu kirim lagi.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Jawaban gerbang mesin (HTML), bukan dari worker yang sebenarnya. */
const looksLikeGateway = (res: Response) => {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  return type.includes("text/html");
};

/** Satu percobaan memanggil worker; `null` bila gerbangnya yang menjawab (mesin dijeda/bangun). */
async function tryWorker(job: string, qs: string, body: Uint8Array | null, timeoutMs: number): Promise<Response | null> {
  const base = workerBase();
  const key = (process.env[ENV_KEY] || "").trim();
  let res: Response;
  try {
    res = await fetch(`${base}/v1/${job}?${qs}`, {
      method: "POST",
      headers: { "x-worker-key": key, "content-type": "application/octet-stream" },
      body: body ? (body as BodyInit) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!res.ok && looksLikeGateway(res)) return null;
  return res;
}

export function workerBase(): string {
  let raw = (process.env[ENV_URL] || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  return raw.replace(/\/+$/, "").replace(/\/health$/i, "");
}

export function workerConfigured(): boolean {
  return !!(workerBase() && (process.env[ENV_KEY] || "").trim());
}

export type WorkerHealth = {
  status: "not_configured" | "connected" | "auth_error" | "unreachable";
  version?: string;
  jobs?: number;
  /** true bila jawabannya halaman gerbang: mesin worker sedang dijeda dan perlu dibangunkan. */
  paused?: boolean;
};

/** Periksa sambungan dan kecocokan kunci dengan mesin worker tanpa membocorkan alamat atau kuncinya. */
export async function pingWorker(timeoutMs = 4000): Promise<WorkerHealth> {
  const base = workerBase();
  const key = (process.env[ENV_KEY] || "").trim();
  if (!base || !key) return { status: "not_configured" };
  try {
    const res = await fetch(`${base}/health`, {
      headers: { "x-worker-key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // Gerbang mesin menjawab HTML saat mesinnya dijeda; petunjuk ini dipakai pesan galat.
      return { status: "unreachable", paused: looksLikeGateway(res) };
    }
    const data = (await res.json().catch(() => null)) as { ok?: boolean; version?: string; jobs?: unknown[] } | null;
    if (!data?.ok) return { status: "unreachable" };
    // Dengan kunci yang cocok, /health menyertakan daftar `jobs`; tanpanya berarti WORKER_KEY berbeda.
    if (!Array.isArray(data.jobs)) return { status: "auth_error", version: data.version };
    return { status: "connected", version: data.version, jobs: data.jobs.length };
  } catch {
    return { status: "unreachable" };
  }
}

/** Nama berkas hasil buatan worker: acak, jadi tidak bisa ditebak. */
export const WORKER_FILE_RE = /^[A-Za-z0-9_-]{20,40}\.(mp3|ogg|wav|m4a|mp4|gif|webp|png|jpg|pdf)$/;

type Params = Record<string, string | number | boolean | undefined>;

async function callWorker(job: string, params: Params, body: Uint8Array | null, timeoutMs: number): Promise<Response> {
  const base = workerBase();
  const key = (process.env[ENV_KEY] || "").trim();
  if (!base || !key) throw new HttpError(503, `Fitur ini belum aktif: ${ENV_URL} dan ${ENV_KEY} belum diatur di server.`);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "" && v !== false) qs.set(k, v === true ? "1" : String(v));

  let res = await tryWorker(job, qs.toString(), body, timeoutMs);
  if (!res) {
    // Kemungkinan mesinnya sedang bangun dari jeda: beri waktu sekali lagi.
    await sleep(WAKE_RETRY_MS);
    res = await tryWorker(job, qs.toString(), body, timeoutMs);
  }
  if (!res) throw new HttpError(503, WAKING);
  if (res.ok) return res;

  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const msg = typeof data?.error === "string" && data.error.trim() ? data.error.trim().slice(0, 300) : "";
  // Tanpa pesan JSON, jawabannya bukan dari worker (gerbang mesin, port ditutup).
  if (!msg) throw new HttpError(503, WAKING);
  if (res.status === 401) {
    console.error("[worker] kunci ditolak: WORKER_KEY di server ini berbeda dengan di mesin worker.");
    throw new HttpError(503, "Fitur ini sedang tidak bisa dipakai karena salah konfigurasi di server. Hubungi pemilik API.");
  }
  if ([400, 404, 413, 415, 422].includes(res.status)) throw new HttpError(res.status === 404 ? 502 : res.status === 422 ? 400 : res.status, msg);
  if (res.status === 503 || res.status === 504) throw new HttpError(res.status, msg);
  throw new HttpError(502, msg);
}

/** Berkas dari isi permintaan POST: multipart (field `file`) atau isi mentah. `null` bila tidak ada. */
async function readUpload(req: Request): Promise<Uint8Array | null> {
  if (req.method !== "POST") return null;
  const tooBig = `Berkas terlalu besar untuk diunggah (maks ${MAX_UPLOAD_MB} MB). Untuk berkas yang lebih besar, kirim tautannya lewat parameter 'url'.`;
  if (Number(req.headers.get("content-length")) > MAX_UPLOAD + 64 * 1024) throw new HttpError(413, tooBig);
  const type = (req.headers.get("content-type") || "").toLowerCase();
  let buf: Uint8Array;
  if (type.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, "Isi formulir tidak bisa dibaca. Kirim sebagai multipart/form-data dengan field 'file'.");
    }
    const part = form.get("file");
    if (part === null) return null;
    if (typeof part === "string") throw new HttpError(400, "Field 'file' harus berisi berkas, bukan teks.");
    buf = new Uint8Array(await part.arrayBuffer());
  } else {
    buf = new Uint8Array(await req.arrayBuffer());
  }
  if (!buf.length) return null;
  if (buf.length > MAX_UPLOAD) throw new HttpError(413, tooBig);
  return buf;
}

/** Sumber berkas: unggahan, atau tautan publik di parameter `url` (worker yang mengunduhnya). */
async function source(ctx: Ctx): Promise<{ body: Uint8Array | null; url?: string }> {
  const body = await readUpload(ctx.req);
  if (body) return { body };
  const raw = opt(ctx.sp, "url");
  if (!raw) throw new HttpError(400, "Tidak ada berkas yang dikirim. Isi parameter 'url' dengan tautan berkasnya, atau unggah lewat POST (multipart/form-data, field 'file').");
  if (raw.length > 2000) throw new HttpError(400, "Parameter 'url' terlalu panjang (maks 2000 karakter).");
  return { body: null, url: parseHttpUrl(raw).toString() };
}

function flag(sp: URLSearchParams, name: string): boolean {
  return /^(1|true|ya|yes|on)$/i.test(opt(sp, name));
}

function choice(sp: URLSearchParams, name: string, options: readonly string[], fallback: string): string {
  const v = opt(sp, name).toLowerCase();
  if (!v) return fallback;
  if (!options.includes(v)) throw new HttpError(400, `Parameter '${name}' harus salah satu dari: ${options.join(", ")}.`);
  return v;
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type FileResult = { file: string; type: string; size: number; expires_in: number } & Record<string, unknown>;

/** Jawaban worker yang berupa berkas tersimpan: ubah jadi tautan di domain ini (/w/<nama>). */
async function fileResult(res: Response, origin: string): Promise<Record<string, unknown>> {
  const data = (await res.json().catch(() => null)) as FileResult | null;
  if (!data || typeof data.file !== "string" || !WORKER_FILE_RE.test(data.file)) throw new HttpError(502, "Server pengolah mengirim jawaban yang tidak valid.");
  const { file, type, size, expires_in, ...rest } = data;
  return {
    url: `${origin}/w/${file}`,
    type,
    size,
    size_text: sizeText(size),
    ...rest,
    expires: new Date(Date.now() + (Number(expires_in) || 3600) * 1000).toISOString(),
  };
}

/** Jawaban worker yang berupa berkas langsung (gambar): alirkan ke pemanggil. */
function passThrough(res: Response, prefix: string): Response {
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith(prefix)) throw new HttpError(502, "Server pengolah mengirim jawaban yang tidak valid.");
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "private, max-age=300" } });
}

const upload = (accept: string, what: string): Upload => ({
  field: "file",
  accept,
  maxBytes: MAX_UPLOAD,
  description: `${what} dari perangkatmu (maks ${MAX_UPLOAD_MB} MB). Dikirim lewat POST. Untuk berkas yang lebih besar, pakai parameter url.`,
});

const KEEP = "Tautan hasil berlaku 1 jam, lalu berkasnya dihapus.";
const MEDIA_URL = "Tautan langsung ke berkasnya yang bisa diakses publik. Tidak perlu diisi bila mengunggah berkas.";
const DEVICES = ["desktop", "tablet", "mobile"] as const;

export const workerEndpoints: Endpoint[] = [
  {
    category: "tools", slug: "ssweb", kind: "image",
    title: "Screenshot Website v2",
    description: "Tangkapan layar halaman web dari browser di server sendiri. Bisa satu halaman penuh dari atas sampai bawah, mode gelap, dan jeda tunggu untuk halaman yang lambat. Hasilnya langsung berupa gambar.",
    params: [
      { name: "url", required: true, description: "Alamat halaman web.", example: "https://nextjs.org" },
      { name: "device", description: "Perangkat: desktop (1366x768), tablet (820x1180), atau mobile (390x844). Default desktop.", example: "desktop", options: [...DEVICES] },
      { name: "full", description: "Isi 1 untuk memotret seluruh halaman dari atas sampai bawah (maks tinggi 12.000 piksel).", example: "1", options: ["0", "1"] },
      { name: "dark", description: "Isi 1 untuk mode gelap, bila situsnya mendukung.", example: "0", options: ["0", "1"] },
      { name: "format", description: "png atau jpg. Default png. Gambar di atas 4 MB otomatis dikirim sebagai jpg.", example: "png", options: ["png", "jpg"] },
      { name: "wait", description: "Jeda tambahan setelah halaman dimuat, 0 sampai 10 detik. Default 0.", example: "0" },
    ],
    handler: async ({ sp }) => {
      const url = parseHttpUrl(need(sp, "url", 2000)).toString();
      const res = await callWorker("ssweb", {
        url,
        device: choice(sp, "device", DEVICES, "desktop"),
        full: flag(sp, "full"),
        dark: flag(sp, "dark"),
        format: choice(sp, "format", ["png", "jpg"], "png"),
        wait: Math.round(num(sp, "wait", 0, 0, 10)),
      }, null, 75_000);
      return passThrough(res, "image/");
    },
  },
  {
    category: "tools", slug: "web2pdf", kind: "json",
    title: "Website ke PDF",
    description: `Simpan sebuah halaman web sebagai berkas PDF, lengkap dengan gambar dan warna latarnya. Hasilnya tautan unduhan PDF. ${KEEP}`,
    params: [
      { name: "url", required: true, description: "Alamat halaman web.", example: "https://example.com" },
      { name: "paper", description: "Ukuran kertas: a4, letter, legal, atau a3. Default a4.", example: "a4", options: ["a4", "letter", "legal", "a3"] },
      { name: "landscape", description: "Isi 1 untuk kertas mendatar.", example: "0", options: ["0", "1"] },
      { name: "wait", description: "Jeda tambahan setelah halaman dimuat, 0 sampai 10 detik. Default 0.", example: "0" },
    ],
    handler: async ({ sp, origin }) => {
      const url = parseHttpUrl(need(sp, "url", 2000)).toString();
      const res = await callWorker("web2pdf", { url, paper: choice(sp, "paper", ["a4", "letter", "legal", "a3"], "a4"), landscape: flag(sp, "landscape"), wait: Math.round(num(sp, "wait", 0, 0, 10)) }, null, 75_000);
      return fileResult(res, origin);
    },
  },
  {
    category: "tools", slug: "tomp3", kind: "json",
    title: "Video ke MP3",
    description: `Ambil suara dari video atau ubah format audio. Pilih mp3, ogg (Opus, format pesan suara WhatsApp), atau m4a. Durasi maks 10 menit. ${KEEP}`,
    params: [
      { name: "url", description: MEDIA_URL, example: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
      { name: "format", description: "mp3, ogg, atau m4a. Default mp3.", example: "mp3", options: ["mp3", "ogg", "m4a"] },
      { name: "bitrate", description: "Mutu suara dalam kbps untuk mp3 dan m4a: 96, 128, 192, 256, atau 320. Default 128.", example: "128", options: ["96", "128", "192", "256", "320"] },
    ],
    upload: upload("video/*,audio/*", "Berkas video atau audio"),
    handler: async (ctx) => {
      const { sp, origin } = ctx;
      const params = { format: choice(sp, "format", ["mp3", "ogg", "m4a"], "mp3"), bitrate: choice(sp, "bitrate", ["96", "128", "192", "256", "320"], "128") };
      const src = await source(ctx);
      return fileResult(await callWorker("tomp3", { ...params, url: src.url }, src.body, 110_000), origin);
    },
  },
  {
    category: "tools", slug: "togif", kind: "json",
    title: "Video ke GIF",
    description: `Ubah potongan video menjadi GIF. Atur detik mulai, panjang potongan (maks 15 detik), lebar, dan jumlah frame per detik. ${KEEP}`,
    params: [
      { name: "url", description: MEDIA_URL, example: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
      { name: "start", description: "Detik mulai potongan. Default 0.", example: "0" },
      { name: "duration", description: "Panjang potongan, 0,5 sampai 15 detik. Default 6.", example: "4" },
      { name: "width", description: "Lebar GIF, 120 sampai 640 piksel. Default 360.", example: "360" },
      { name: "fps", description: "Frame per detik, 5 sampai 20. Default 12.", example: "12" },
    ],
    upload: upload("video/*,image/gif", "Berkas video"),
    handler: async (ctx) => {
      const { sp, origin } = ctx;
      const params = { start: num(sp, "start", 0, 0, 36000), duration: num(sp, "duration", 6, 0.5, 15), width: Math.round(num(sp, "width", 360, 120, 640)), fps: Math.round(num(sp, "fps", 12, 5, 20)) };
      const src = await source(ctx);
      return fileResult(await callWorker("togif", { ...params, url: src.url }, src.body, 110_000), origin);
    },
  },
  {
    category: "tools", slug: "compress", kind: "json",
    title: "Kompres Video",
    description: `Perkecil ukuran video (MP4, H.264) supaya lebih ringan dikirim. Pilih mutu low (480p), medium (720p), atau high (1080p). Durasi maks 5 menit. ${KEEP}`,
    params: [
      { name: "url", description: MEDIA_URL, example: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
      { name: "quality", description: "low (paling kecil), medium, atau high (paling tajam). Default medium.", example: "medium", options: ["low", "medium", "high"] },
    ],
    upload: upload("video/*", "Berkas video"),
    handler: async (ctx) => {
      const { sp, origin } = ctx;
      const quality = choice(sp, "quality", ["low", "medium", "high"], "medium");
      const src = await source(ctx);
      return fileResult(await callWorker("compress", { quality, url: src.url }, src.body, 115_000), origin);
    },
  },
  {
    category: "tools", slug: "sticker", kind: "image",
    title: "Pembuat Stiker WhatsApp",
    description: "Ubah gambar, GIF, atau video pendek menjadi stiker WhatsApp: WebP 512x512 dengan latar transparan. Video dan GIF menjadi stiker bergerak (maks 10 detik, di bawah 1 MB). Hasilnya langsung berupa berkas WebP.",
    params: [
      { name: "url", description: MEDIA_URL, example: "https://github.com/github.png" },
      { name: "fit", description: "contain (seluruh gambar terlihat, sisanya transparan) atau cover (dipotong memenuhi kotak). Default contain.", example: "contain", options: ["contain", "cover"] },
      { name: "duration", description: "Untuk video dan GIF: panjang stiker, 1 sampai 10 detik. Default 6.", example: "6" },
    ],
    upload: upload("image/*,video/*", "Berkas gambar, GIF, atau video pendek"),
    handler: async (ctx) => {
      const { sp } = ctx;
      const params = { fit: choice(sp, "fit", ["contain", "cover"], "contain"), duration: num(sp, "duration", 6, 1, 10) };
      const src = await source(ctx);
      return passThrough(await callWorker("sticker", { ...params, url: src.url }, src.body, 110_000), "image/");
    },
  },
  {
    category: "image", slug: "removebg", kind: "image",
    title: "Hapus Latar Gambar",
    description: "Hapus latar belakang foto secara otomatis. Hasilnya PNG transparan yang hanya berisi objek utamanya. Paling bagus untuk foto dengan satu objek yang jelas, misalnya orang atau produk.",
    params: [{ name: "url", description: "Tautan langsung ke gambar (JPG, PNG, atau WebP) yang bisa diakses publik. Tidak perlu diisi bila mengunggah berkas.", example: "https://github.com/github.png" }],
    upload: upload("image/png,image/jpeg,image/webp", "Berkas gambar (PNG, JPG, atau WebP)"),
    handler: async (ctx) => {
      const src = await source(ctx);
      return passThrough(await callWorker("removebg", { url: src.url }, src.body, 110_000), "image/");
    },
  },
  {
    category: "tools", slug: "ocr", kind: "json",
    title: "OCR: Gambar ke Teks",
    description: "Baca tulisan di dalam gambar, misalnya tangkapan layar, foto dokumen, atau poster. Hasilnya teks per baris. Paling akurat untuk tulisan cetak yang tajam; tulisan tangan sering meleset.",
    params: [{ name: "url", description: "Tautan langsung ke gambar (JPG, PNG, atau WebP) yang bisa diakses publik. Tidak perlu diisi bila mengunggah berkas.", example: "https://dummyimage.com/900x200/ffffff/000000.png&text=Selamat+datang+di+yanz.api" }],
    upload: upload("image/png,image/jpeg,image/webp", "Berkas gambar (PNG, JPG, atau WebP)"),
    handler: async (ctx) => {
      const src = await source(ctx);
      const res = await callWorker("ocr", { url: src.url }, src.body, 110_000);
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!data || typeof data.text !== "string") throw new HttpError(502, "Server pengolah mengirim jawaban yang tidak valid.");
      return data;
    },
  },
  {
    category: "ai", slug: "transcribe", kind: "json",
    title: "Suara ke Teks",
    description: "Ubah ucapan di rekaman suara atau video menjadi teks dengan model Whisper, misalnya untuk pesan suara WhatsApp. Bahasa dikenali otomatis. Durasi maks 3 menit.",
    params: [
      { name: "url", description: MEDIA_URL },
      { name: "lang", description: "Kode bahasa dua huruf bila sudah tahu, misalnya id atau en. Kosongkan untuk deteksi otomatis.", example: "id" },
    ],
    upload: upload("audio/*,video/*", "Berkas suara atau video"),
    handler: async (ctx) => {
      const lang = opt(ctx.sp, "lang").toLowerCase();
      if (lang && !/^[a-z]{2,3}$/.test(lang)) throw new HttpError(400, "Parameter 'lang' harus berupa kode bahasa dua huruf, misalnya id atau en.");
      const src = await source(ctx);
      const res = await callWorker("transcribe", { lang, url: src.url }, src.body, 115_000);
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!data || typeof data.text !== "string") throw new HttpError(502, "Server pengolah mengirim jawaban yang tidak valid.");
      return data;
    },
  },
  {
    category: "ai", slug: "tts", kind: "json",
    title: "Teks ke Suara",
    description: `Bacakan teks dengan suara bahasa Indonesia. Pilih mp3, ogg (Opus, format pesan suara WhatsApp), atau wav. Maks 600 karakter. ${KEEP}`,
    params: [
      { name: "text", required: true, description: "Teks yang dibacakan (maks 600 karakter).", example: "Halo, selamat datang di yanz api." },
      { name: "speed", description: "Kecepatan bicara, 0,5 (lambat) sampai 2 (cepat). Default 1.", example: "1" },
      { name: "format", description: "mp3, ogg, atau wav. Default mp3.", example: "mp3", options: ["mp3", "ogg", "wav"] },
    ],
    handler: async ({ sp, origin }) => {
      const text = need(sp, "text", 600).replace(/\s+/g, " ");
      const res = await callWorker("tts", { text, speed: num(sp, "speed", 1, 0.5, 2), format: choice(sp, "format", ["mp3", "ogg", "wav"], "mp3") }, null, 110_000);
      return fileResult(res, origin);
    },
  },
];
