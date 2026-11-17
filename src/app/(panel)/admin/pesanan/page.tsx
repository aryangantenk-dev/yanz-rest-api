import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pesanan · Admin",
  description: "Panel admin: pesanan paket dan limit tambahan.",
  alternates: { canonical: "/admin/pesanan" },
  robots: { index: false, follow: false },
};

// Isi halaman ini digambar oleh AdminPanel di layout /admin, yang memilih bagiannya dari alamat halaman.
export default function AdminOrdersPage() {
  return null;
}
