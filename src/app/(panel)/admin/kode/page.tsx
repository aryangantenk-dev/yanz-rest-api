import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Kode · Admin",
  description: "Panel admin: kode tukar untuk paket atau limit tambahan.",
  alternates: { canonical: "/admin/kode" },
  robots: { index: false, follow: false },
};

// Isi halaman ini digambar oleh AdminPanel di layout /admin, yang memilih bagiannya dari alamat halaman.
export default function AdminCodesPage() {
  return null;
}
