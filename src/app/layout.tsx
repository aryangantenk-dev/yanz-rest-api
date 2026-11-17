import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { AUTH_ENABLED } from "@/lib/auth/config";
import { HOME_DESCRIPTION, HOME_SHARE_TITLE, HOME_TITLE, KEYWORDS, jsonLdText, siteJsonLd } from "@/lib/seo";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";

// Font disimpan di repo (lisensi OFL-1.1) supaya build tidak bergantung pada jaringan
// dan ruang hurufnya sudah dipesan sejak awal (tanpa pergeseran tata letak).
const body = localFont({
  src: "./fonts/ibm-plex-sans-latin-wght-normal.woff2",
  variable: "--font-body",
  weight: "100 700",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "Segoe UI", "Arial", "sans-serif"],
});
const code = localFont({
  src: "./fonts/jetbrains-mono-latin-wght-normal.woff2",
  variable: "--font-code",
  weight: "100 800",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

// Nilai bawaan untuk semua halaman. Beranda, dokumentasi, dan halaman publik lain menimpanya
// dengan judul, canonical, dan Open Graph miliknya sendiri lewat pageMeta() di src/lib/seo.ts.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: HOME_TITLE, template: `%s | ${SITE_NAME}` },
  description: HOME_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: KEYWORDS,
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
  // Tanpa `url`: halaman yang tidak punya Open Graph sendiri tidak boleh mengaku beralamat di beranda.
  openGraph: { type: "website", locale: "id_ID", siteName: SITE_NAME, title: HOME_SHARE_TITLE, description: HOME_DESCRIPTION },
  twitter: { card: "summary_large_image", title: HOME_SHARE_TITLE, description: HOME_DESCRIPTION },
  appleWebApp: { title: SITE_NAME },
  category: "technology",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

// Dijalankan sebelum halaman digambar agar pilihan tema tersimpan tidak berkedip.
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
// Menandai browser yang terakhir kali dalam keadaan masuk, sebelum halaman digambar (lihat .only-signed di globals.css).
const signedScript = AUTH_ENABLED ? `try{if(localStorage.getItem("yn_signed_in")==="1")document.documentElement.dataset.signed="1"}catch(e){}` : "";

// Tautan referral (?ref=KODE): simpan kodenya 30 hari supaya masih ada saat pendaftar selesai masuk,
// termasuk setelah berpindah ke Google dan kembali. Lihat src/lib/billing/referral.ts.
const refScript = AUTH_ENABLED
  ? `try{var r=new URLSearchParams(location.search).get("ref");if(r&&/^[0-9A-Za-z]{6,12}$/.test(r))document.cookie="yn_ref="+r.toUpperCase()+"; path=/; max-age=2592000; samesite=lax"+(location.protocol==="https:"?"; secure":"")}catch(e){}`
  : "";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className={`${body.variable} ${code.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript + signedScript + refScript }} />
        {/* Data terstruktur situs: WebSite, Organization, SoftwareApplication (lihat siteJsonLd). */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(siteJsonLd()) }} />
      </head>
      <body className="flex min-h-dvh flex-col font-sans">
        <a href="#konten" className="btn btn-primary fixed left-4 top-2 z-[100] -translate-y-24 focus:translate-y-0">
          Lewati ke konten
        </a>
        {/* Kerangka halaman (header, menu, footer) ada di layout tiap bagian:
            (site) untuk beranda dan dokumentasi, (auth) untuk masuk dan daftar, (panel) untuk area anggota. */}
        {children}
      </body>
    </html>
  );
}
