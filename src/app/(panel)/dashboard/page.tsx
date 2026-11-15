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
  return <DashboardPanel authEnabled={AUTH_ENABLED} />;
}
