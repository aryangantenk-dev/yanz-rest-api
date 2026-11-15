import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blokir IP · Admin",
  description: "Panel admin: alamat IP yang diblokir.",
  alternates: { canonical: "/admin/blokir-ip" },
  robots: { index: false, follow: false },
};

// Isi halaman ini digambar oleh AdminPanel di layout /admin, yang memilih bagiannya dari alamat halaman.
export default function AdminIpPage() {
  return null;
}
