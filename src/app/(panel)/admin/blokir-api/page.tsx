import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blokir API · Admin",
  description: "Panel admin: akun yang API-nya diblokir.",
  alternates: { canonical: "/admin/blokir-api" },
  robots: { index: false, follow: false },
};

// Isi halaman ini digambar oleh AdminPanel di layout /admin, yang memilih bagiannya dari alamat halaman.
export default function AdminKeyBlockPage() {
  return null;
}
