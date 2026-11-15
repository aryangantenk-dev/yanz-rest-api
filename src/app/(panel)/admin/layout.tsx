import type { ReactNode } from "react";
import { AdminPanel } from "@/components/admin-panel";
import { AUTH_ENABLED } from "@/lib/auth/config";
import { PLANS, PLAN_DAYS } from "@/lib/plans";
import { allMeta } from "@/lib/api/registry";
import { categories } from "@/lib/api/categories";

// Tiap bagian admin punya halaman (alamat dan judul) sendiri di bawah /admin. Panelnya dipasang di
// layout ini supaya data yang sudah dimuat tidak diambil ulang setiap kali berpindah halaman admin;
// bagian yang digambar dipilih dari alamat halaman. Semua datanya diambil dari /api/admin, yang
// memeriksa sendiri bahwa pemanggilnya akun admin.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AdminPanel
        authEnabled={AUTH_ENABLED}
        plans={PLANS.map((p) => ({ id: p.id, name: p.name, paid: p.price > 0 }))}
        planDays={PLAN_DAYS}
        endpoints={allMeta().map((e) => ({ id: `${e.category}/${e.slug}`, title: e.title, category: e.category }))}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
      />
      {children}
    </>
  );
}
