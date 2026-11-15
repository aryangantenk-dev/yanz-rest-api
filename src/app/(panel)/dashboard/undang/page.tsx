import type { Metadata } from "next";
import { ReferralPanel } from "@/components/dashboard-panel";
import { AUTH_ENABLED } from "@/lib/auth/config";

export const metadata: Metadata = {
  title: "Undang teman",
  description: "Tautan undangan akunmu dan limit tambahan yang sudah kamu dapat dari pembelian teman yang kamu ajak.",
  alternates: { canonical: "/dashboard/undang" },
  robots: { index: false, follow: false },
};

export default function ReferralPage() {
  return (
    <div className="max-w-3xl">
      <ReferralPanel authEnabled={AUTH_ENABLED} />
    </div>
  );
}
