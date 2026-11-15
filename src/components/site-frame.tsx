import type { ReactNode } from "react";
import { endpoints } from "@/lib/api/registry";
import { AUTH_ENABLED } from "@/lib/auth/config";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

/** Kerangka halaman publik (beranda, dokumentasi, 404): header situs, isi, dan footer. */
export function SiteFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader authEnabled={AUTH_ENABLED} />
      <main id="konten" tabIndex={-1} className="flex-1 pt-[var(--header-h)] outline-none">
        {children}
      </main>
      <SiteFooter total={endpoints.length} />
    </>
  );
}
