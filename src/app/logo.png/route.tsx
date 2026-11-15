import { ImageResponse } from "next/og";

// Logo sebagai berkas gambar 512 x 512 di /logo.png. Dipakai data terstruktur (Organization.logo),
// karena logo di halaman berupa SVG sebaris dan favicon (/icon) terlalu kecil untuk itu.
export const dynamic = "force-static";

// ImageResponse tidak membaca variabel CSS, jadi warna merek ditulis langsung di sini.
export function GET() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#22C55E" }}>
        <svg width="512" height="512" viewBox="0 0 32 32" fill="none">
          <path d="M9 8l7 9.5L23 8M16 17.5V25" stroke="#0F172A" strokeWidth="3.2" strokeLinecap="square" strokeLinejoin="miter" />
        </svg>
      </div>
    ),
    { width: 512, height: 512 },
  );
}
