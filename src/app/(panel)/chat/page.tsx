import type { Metadata } from "next";
import { ChatPanel } from "@/components/chat-panel";
import { AUTH_ENABLED } from "@/lib/auth/config";

export const metadata: Metadata = {
  title: "Chat global",
  description: "Ruang obrolan untuk semua anggota: tanya soal endpoint, berbagi proyek, atau sekadar menyapa.",
  alternates: { canonical: "/chat" },
  robots: { index: false, follow: false },
};

export default function ChatPage() {
  return (
    <div className="max-w-3xl">
      <ChatPanel authEnabled={AUTH_ENABLED} />
    </div>
  );
}
