import type { Endpoint } from "./types";
import { HttpError } from "./types";
import { need, opt } from "./helpers";

/*
  Email sementara dari TMailCloud (tmailcloud.my.id). Alamatnya tidak kedaluwarsa:
  dibuat sekali lewat /api/email/generate, lalu kotak masuknya dibaca lewat
  /api/email/inbox/<alamat>. Tidak ada kunci API, jadi cukup panggil langsung.
*/

const BASE = "https://tmailcloud.my.id";
const DOMAINS = ["tmailcloud.my.id", "tmailcloud.biz.id", "e-bisnis.my.id", "bussiness.biz.id"];

const HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "id-ID,id;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8"',
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": '"Android"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

type Inbox = { id?: string; address?: string; username?: string; domain?: string; is_permanent?: boolean };

async function call(path: string, init: RequestInit, referer: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...HEADERS, origin: BASE, referer, ...(init.headers as Record<string, string> | undefined) },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new HttpError(502, "Server TMailCloud tidak bisa dihubungi. Coba lagi nanti.");
  }
  const text = await res.text();
  if (res.status === 429) throw new HttpError(429, "TMailCloud sedang membatasi permintaan. Coba lagi sebentar lagi.");
  if (res.status >= 400) throw new HttpError(502, `TMailCloud menolak permintaan (HTTP ${res.status}).`);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(502, "Jawaban TMailCloud tidak bisa dibaca.");
  }
  if (data.success !== true) {
    const msg = typeof data.error === "string" && data.error.trim() ? data.error.trim() : "TMailCloud menolak permintaan.";
    throw new HttpError(msg.toLowerCase().includes("domain") ? 400 : 502, msg);
  }
  return data;
}

/** Buat alamat baru. `username` kosong berarti dibuat acak. */
async function create(username: string, domain: string): Promise<Record<string, unknown>> {
  const user = username || `yn-${Buffer.from(Math.random().toString(36).slice(2, 10)).toString("hex")}`;
  const dom = domain.replace(/^@/, "").toLowerCase();
  if (!DOMAINS.includes(dom)) {
    throw new HttpError(400, `Domain '${dom}' tidak ada di TMailCloud. Pilihan: ${DOMAINS.join(", ")}.`);
  }
  const data = await call(
    "/api/email/generate",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain: dom, username: user }) },
    `${BASE}/${user}@${dom}`,
  );
  const inbox = (data.inbox ?? {}) as Inbox;
  return {
    email: (data.email as string | undefined) ?? inbox.address ?? `${user}@${dom}`,
    username: inbox.username ?? user,
    domain: inbox.domain ?? dom,
    id: inbox.id ?? null,
    permanent: inbox.is_permanent === true,
    inbox: `${BASE}/api/email/inbox/${encodeURIComponent((data.email as string | undefined) ?? `${user}@${dom}`)}`,
  };
}

/** Ambil kotak masuk sebuah alamat, sekaligus ambil kode verifikasi bila ada. */
async function inbox(email: string): Promise<Record<string, unknown>> {
  const address = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new HttpError(400, "Parameter 'email' harus berupa alamat email yang valid.");
  const data = await call(`/api/email/inbox/${encodeURIComponent(address)}`, { method: "GET" }, `${BASE}/${address}`);
  const raw = Array.isArray(data.messages) ? (data.messages as Record<string, unknown>[]) : [];
  const messages = raw.map((m) => {
    const html = typeof m.body_html === "string" ? m.body_html.replace(/<[^>]*>/g, " ") : "";
    const body = (typeof m.body_text === "string" && m.body_text.trim() ? m.body_text : html).replace(/\s{2,}/g, " ").trim();
    return {
      id: m.id ?? null,
      from: m.sender_name || m.sender || null,
      email_from: m.sender ?? null,
      subject: m.subject || "(tanpa subjek)",
      body: body || "Tidak ada isi pesan.",
      otp_code: m.verification_code ?? null,
      is_read: m.is_read === true,
      date: typeof m.created_at === "number" && m.created_at > 0 ? new Date(m.created_at).toISOString() : null,
    };
  });
  return {
    email: (data.address as string | undefined) ?? address,
    total: typeof data.count === "number" ? data.count : messages.length,
    latest_otp: messages.find((m) => m.otp_code)?.otp_code ?? null,
    messages,
  };
}

export const tempMailEndpoints: Endpoint[] = [
  {
    category: "tools",
    slug: "tempmail-domains",
    kind: "json",
    aliases: ["tempmail-domain"],
    title: "Email Sementara: Daftar Domain",
    description: "Daftar domain yang tersedia untuk alamat email sementara TMailCloud. Alamat yang dibuat dari layanan ini tidak kedaluwarsa.",
    params: [],
    handler: async () => ({ total: DOMAINS.length, domains: DOMAINS }),
  },
  {
    category: "tools",
    slug: "tempmail",
    kind: "json",
    title: "Email Sementara: Buat Alamat",
    description:
      "Buat alamat email sementara baru dengan nama acak. Alamatnya tidak kedaluwarsa dan langsung bisa menerima pesan. Baca pesan yang masuk dengan /api/tools/tempmail-inbox.",
    params: [
      { name: "domain", description: `Domain yang dipakai. Default ${DOMAINS[0]}. Pilihan lain: ${DOMAINS.slice(1).join(", ")}.`, example: "tmailcloud.my.id" },
    ],
    handler: async ({ sp }) => create("", opt(sp, "domain") || DOMAINS[0]),
  },
  {
    category: "tools",
    slug: "tempmail-custom",
    kind: "json",
    title: "Email Sementara: Alamat Pilihan Sendiri",
    description: "Buat alamat email sementara dengan nama dan domain pilihanmu, misalnya untuk mendaftar layanan tertentu. Alamatnya tidak kedaluwarsa.",
    params: [
      { name: "username", required: true, description: "Nama di depan '@'. Huruf, angka, titik, garis bawah, atau strip.", example: "jhfiony" },
      { name: "domain", description: `Domain yang dipakai. Default ${DOMAINS[0]}.`, example: "e-bisnis.my.id" },
    ],
    handler: async ({ sp }) => {
      const username = need(sp, "username", 60).replace(/[^a-zA-Z0-9._-]/g, "");
      if (!username) throw new HttpError(400, "Parameter 'username' tidak boleh kosong.");
      return create(username, opt(sp, "domain") || DOMAINS[0]);
    },
  },
  {
    category: "tools",
    slug: "tempmail-inbox",
    kind: "json",
    title: "Email Sementara: Baca Kotak Masuk",
    description:
      "Baca semua pesan yang masuk ke sebuah alamat email sementara TMailCloud, lengkap dengan pengirim, subjek, isi pesan, dan kode verifikasi bila pesannya memuat OTP.",
    params: [
      { name: "email", required: true, description: "Alamat email sementara yang ingin dibaca.", example: "jhfiony@e-bisnis.my.id" },
    ],
    handler: async ({ sp }) => inbox(need(sp, "email", 200)),
  },
];
