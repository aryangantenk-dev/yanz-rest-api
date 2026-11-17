import type { Metadata } from "next";
import { HistoryPanel } from "@/components/dashboard-panel";
import { AUTH_ENABLED } from "@/lib/auth/config";

export const metadata: Metadata = {
  title: "Riwayat",
  description: "Riwayat permintaan terakhir yang memakai API key kamu: endpoint, waktu, lama proses, dan kode status.",
  alternates: { canonical: "/dashboard/riwayat" },
  robots: { index: false, follow: false },
};

export default function HistoryPage() {
  return <HistoryPanel authEnabled={AUTH_ENABLED} />;
}
