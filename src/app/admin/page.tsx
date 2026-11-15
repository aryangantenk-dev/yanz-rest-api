import type { Metadata } from "next";
import { AdminPanel } from "@/components/admin-panel";
import { AUTH_ENABLED } from "@/lib/auth/config";
import { PLANS, PLAN_DAYS } from "@/lib/plans";
import { allMeta } from "@/lib/api/registry";
import { categories } from "@/lib/api/categories";

export const metadata: Metadata = {
  title: "Admin",
  description: "Panel admin: akun pengguna, pesanan paket, blokir IP, blokir API, dan status pembayaran.",
  alternates: { canonical: "/admin" },
  robots: { index: false, follow: false },
};

// Halaman ini hanya kerangka; semua datanya diambil dari /api/admin, yang memeriksa sendiri
// bahwa pemanggilnya akun admin.
export default function AdminPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-10 sm:px-6 sm:pt-16">
      <AdminPanel
        authEnabled={AUTH_ENABLED}
        plans={PLANS.map((p) => ({ id: p.id, name: p.name, paid: p.price > 0 }))}
        planDays={PLAN_DAYS}
        endpoints={allMeta().map((e) => ({ id: `${e.category}/${e.slug}`, title: e.title, category: e.category }))}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
      />
    </div>
  );
}
