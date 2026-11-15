import type { Metadata } from "next";
import { ApiKeyPanel } from "@/components/account-panel";
import { AUTH_ENABLED } from "@/lib/auth/config";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "API key",
  description: "Lihat, salin, dan ganti API key kamu.",
  alternates: { canonical: "/dashboard/api-key" },
  robots: { index: false, follow: false },
};

export default function ApiKeyPage() {
  return (
    <div className="max-w-3xl">
      <ApiKeyPanel authEnabled={AUTH_ENABLED} fallback={SITE_URL} />
    </div>
  );
}
