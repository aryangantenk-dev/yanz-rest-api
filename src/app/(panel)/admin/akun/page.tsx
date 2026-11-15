import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Akun pengguna · Admin",
  description: "Panel admin: akun pengguna, paket, limit tambahan, dan riwayat pemakaiannya.",
  alternates: { canonical: "/admin/akun" },
  robots: { index: false, follow: false },
};

// Isi halaman ini digambar oleh AdminPanel di layout /admin, yang memilih bagiannya dari alamat halaman.
export default function AdminUsersPage() {
  return null;
}
