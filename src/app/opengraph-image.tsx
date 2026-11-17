import { ImageResponse } from "next/og";
import { endpoints } from "@/lib/api/registry";
import { KEY_REQUIRED } from "@/lib/auth/config";
import { BRAND_DOMAIN } from "@/lib/brand";
import { SHARE_IMAGE_ALT } from "@/lib/seo";
import { SITE_NAME } from "@/lib/site";

// Teks pengganti gambar pratinjau tautan (og:image:alt dan twitter:image:alt).
export const alt = SHARE_IMAGE_ALT;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// ImageResponse tidak membaca variabel CSS, jadi warna merek ditulis langsung di sini.
const ink = "#0F172A";
const paper = "#F8FAFC";
const green = "#22C55E";
const greenText = "#14763A";
const muted = "#475569";
const line = "#D5DCE5";

export default function OgImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: paper, color: ink }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 56, height: 56, background: green, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="38" height="38" viewBox="0 0 32 32" fill="none">
              <path d="M9 8l7 9v7M23 8l-7 9" stroke={ink} strokeWidth="3.5" strokeLinecap="square" />
            </svg>
          </div>
          <div style={{ fontSize: 36, fontWeight: 700, display: "flex" }}>{SITE_NAME}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2, display: "flex", flexWrap: "wrap" }}>{endpoints.length} endpoint REST API. {KEY_REQUIRED ? "Gratis, cukup satu API key." : "Gratis, tanpa API key."}</div>
          <div style={{ marginTop: 28, fontSize: 30, color: muted, display: "flex" }}>AI, downloader, canvas, data BMKG, Al-Qur&apos;an, komik, anime, film, dan JKT48 dalam satu base URL.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", borderTop: `2px solid ${line}`, paddingTop: 28, fontSize: 28 }}>
          <div style={{ display: "flex", color: greenText, fontWeight: 700, marginRight: 18 }}>GET</div>
          <div style={{ display: "flex" }}>/api/random/quote</div>
          <div style={{ display: "flex", marginLeft: "auto", fontWeight: 700 }}>{BRAND_DOMAIN}</div>
        </div>
      </div>
    ),
    size,
  );
}
