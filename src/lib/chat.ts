/*
  Chat global (halaman /chat): aturan dan bentuk data yang dipakai bersama oleh server dan browser.
  Berkas ini tidak membaca variabel lingkungan dan tidak menyentuh database, jadi aman di-import
  dari komponen "use client". Akses datanya ada di src/lib/chat-store.ts.
*/

/** Panjang pesan paling banyak, dalam karakter. Sama dengan batas di tabel api_chat_messages. */
export const CHAT_MAX_LENGTH = 500;
/** Baris paling banyak dalam satu pesan, supaya satu pesan tidak memenuhi layar. */
export const CHAT_MAX_LINES = 12;
/** Jeda minimum antara dua pesan dari akun yang sama, dalam detik. */
export const CHAT_COOLDOWN_SEC = 3;
/** Pesan paling banyak per akun dalam satu menit. */
export const CHAT_PER_MINUTE = 10;
/** Jumlah pesan terakhir yang disimpan; yang lebih lama dihapus saat ada pesan baru. */
export const CHAT_KEEP = 1000;
/** Jumlah pesan yang dimuat saat halaman dibuka. */
export const CHAT_PAGE = 50;

export type ChatMessage = {
  id: number;
  body: string;
  /** Waktu kirim (ISO). */
  at: string;
  username: string;
  /** Alamat foto profil pengirim di situs ini, atau kosong bila memakai gambar pengganti. */
  photo: string;
  /** Pengirimnya akun admin. */
  admin: boolean;
};

/**
 * Rapikan teks pesan sebelum disimpan: buang karakter kontrol dan karakter pengatur arah teks
 * (bisa dipakai menyamarkan isi pesan), samakan jenis baris baru, rapatkan baris kosong beruntun,
 * dan batasi jumlah baris. Hasilnya bisa kosong; panjangnya diperiksa pemanggil.
 */
export function cleanChatText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = text.split("\n");
  return lines.length > CHAT_MAX_LINES ? `${lines.slice(0, CHAT_MAX_LINES - 1).join("\n")}\n${lines.slice(CHAT_MAX_LINES - 1).join(" ")}` : text;
}

/** Teks memuat sesuatu yang berbentuk API key situs ini (yn-…). Pesan seperti itu ditolak supaya key tidak bocor ke semua orang. */
export function hasApiKey(text: string): boolean {
  return /yn-[0-9A-Za-z][0-9A-Za-z._-]{18,62}[0-9A-Za-z]/.test(text);
}
