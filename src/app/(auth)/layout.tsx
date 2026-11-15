import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "@/components/icons";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Halaman masuk dan daftar: layar tersendiri tanpa menu beranda maupun menu area anggota,
 * supaya yang terlihat hanya formulirnya.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="border-b border-line bg-bg">
        <div className="mx-auto flex h-[var(--header-h)] max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="flex min-h-11 items-center gap-2.5" aria-label="yanz.api, ke beranda">
            <LogoMark className="h-7 w-7" />
            <span className="font-mono text-lg font-bold tracking-tight">
              yanz<span className="text-ok">.</span>api
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/docs" className="flex min-h-11 items-center px-3 text-[0.9375rem] text-muted transition-colors duration-150 hover:text-fg">
              Dokumentasi
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="konten" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-5 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} yanz.api</p>
          <Link href="/" className="link">
            Kembali ke beranda
          </Link>
        </div>
      </footer>
    </>
  );
}
