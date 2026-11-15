import type { ReactNode } from "react";
import { PanelShell } from "@/components/panel-shell";
import { AUTH_ENABLED } from "@/lib/auth/config";

/**
 * Area anggota: dashboard, riwayat, API key, paket, undang teman, akun, dan panel admin.
 * Kerangkanya terpisah dari beranda dan dokumentasi (lihat PanelShell), dan tiap bagian punya halaman sendiri.
 */
export default function PanelLayout({ children }: { children: ReactNode }) {
  return <PanelShell authEnabled={AUTH_ENABLED}>{children}</PanelShell>;
}
