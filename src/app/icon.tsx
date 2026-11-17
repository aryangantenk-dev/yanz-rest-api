import { ImageResponse } from "next/og";

// Google menampilkan favicon yang berbentuk persegi dengan ukuran kelipatan 48 piksel.
export const size = { width: 96, height: 96 };
export const contentType = "image/png";

// ImageResponse tidak membaca variabel CSS, jadi warna merek ditulis langsung di sini.
export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#22C55E" }}>
        <svg width="66" height="66" viewBox="0 0 32 32" fill="none">
          <path d="M9 8l7 9v7M23 8l-7 9" stroke="#0F172A" strokeWidth="3.5" strokeLinecap="square" />
        </svg>
      </div>
    ),
    size,
  );
}
