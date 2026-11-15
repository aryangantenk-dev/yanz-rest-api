import type { ReactNode } from "react";
import { SiteFrame } from "@/components/site-frame";

/** Bagian publik: beranda dan dokumentasi. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return <SiteFrame>{children}</SiteFrame>;
}
