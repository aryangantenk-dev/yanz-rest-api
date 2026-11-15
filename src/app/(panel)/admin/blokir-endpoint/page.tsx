import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blokir endpoint · Admin",
  description: "Panel admin: endpoint dan kategori yang dimatikan.",
  alternates: { canonical: "/admin/blokir-endpoint" },
  robots: { index: false, follow: false },
};

// Isi halaman ini digambar oleh AdminPanel di layout /admin, yang memilih bagiannya dari alamat halaman.
export default function AdminEndpointPage() {
  return null;
}
