import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pembayaran · Admin",
  description: "Panel admin: status gerbang pembayaran.",
  alternates: { canonical: "/admin/pembayaran" },
  robots: { index: false, follow: false },
};

// Isi halaman ini digambar oleh AdminPanel di layout /admin, yang memilih bagiannya dari alamat halaman.
export default function AdminPaymentPage() {
  return null;
}
