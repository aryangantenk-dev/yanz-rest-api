import type { Metadata } from "next";
import { AccountPanel } from "@/components/account-panel";

export const metadata: Metadata = {
  title: "Akun",
  description: "Profil akunmu: foto, username, dan data pendaftaran.",
  alternates: { canonical: "/akun" },
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return (
    <div className="max-w-3xl">
      <AccountPanel />
    </div>
  );
}
