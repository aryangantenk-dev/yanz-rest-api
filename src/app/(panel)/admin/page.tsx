import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin",
  description: "Panel admin: ringkasan akun, pesanan, dan blokir yang sedang berlaku.",
  alternates: { canonical: "/admin" },
  robots: { index: false, follow: false },
};

// Isi halaman ini digambar oleh AdminPanel di layout /admin, yang memilih bagiannya dari alamat halaman.
export default function AdminPage() {
  return null;
}
