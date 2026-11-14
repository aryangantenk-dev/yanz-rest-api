import type { Metadata } from "next";
import { DashboardPanel } from "@/components/dashboard-panel";
import { AUTH_ENABLED } from "@/lib/auth/config";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Statistik pemakaian API key kamu: permintaan per hari dan endpoint yang paling sering dipakai.",
  alternates: { canonical: "/dashboard" },
  robots: { index: false, follow: false },
};

export default function DashboardPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-10 sm:px-6 sm:pt-16">
      <DashboardPanel authEnabled={AUTH_ENABLED} />
    </div>
  );
}
