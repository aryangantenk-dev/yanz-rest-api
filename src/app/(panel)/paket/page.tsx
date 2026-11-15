import type { Metadata } from "next";
import { PlanPanel } from "@/components/plan-panel";
import { allMeta } from "@/lib/api/registry";
import { AUTH_ENABLED, KEY_REQUIRED } from "@/lib/auth/config";
import { FEE_ON_CUSTOMER, GATEWAY_READY } from "@/lib/billing/welper";
import { APPEAL_URL } from "@/lib/guard";
import { FREE_PLAN, LIMIT_CHOICES, LIMIT_MAX, LIMIT_MIN, LIMIT_PRICE, LIMIT_STEP, MAX_PLAN_DAYS, PLANS, PLAN_DAY_CHOICES, formatNumber, rupiah } from "@/lib/plans";
import { SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: "Paket",
  description: `Pilihan paket ${SITE_NAME}: paket Gratis dengan ${formatNumber(FREE_PLAN.daily)} permintaan per hari, paket harian dengan kuota lebih besar, dan limit tambahan ${rupiah(LIMIT_PRICE * LIMIT_STEP)} per ${formatNumber(LIMIT_STEP)} limit. Dibayar lewat QRIS.`,
  alternates: { canonical: "/paket" },
};

const notes = [
  { t: "Kuota dihitung per akun", d: "Setiap permintaan ke /api yang membawa API key kamu mengurangi kuota harian akunmu, termasuk permintaan yang berakhir dengan galat. Mengganti API key tidak mengembalikan kuota." },
  { t: "Terisi lagi pukul 00.00 WIB", d: "Kuota harian terisi lagi setiap tengah malam WIB. Sisa kuota ada di header x-quota-remaining pada setiap jawaban." },
  { t: "Paket dihitung per hari", d: `Kamu memilih sendiri jumlah harinya, dari 1 sampai ${MAX_PLAN_DAYS} hari. Membeli paket yang sama selagi masih aktif menambah masa aktifnya. Membeli paket lain menggantinya, dan sisa hari paket lama hangus. Tidak ada perpanjangan otomatis: setelah masa aktif habis akun kembali ke paket ${FREE_PLAN.name}.` },
  { t: "Limit tambahan tidak hangus", d: "Limit tambahan baru dipotong setelah kuota harian paketmu habis, satu limit untuk satu permintaan. Saldonya tetap ada sampai terpakai dan tidak terisi ulang sendiri. Permintaan yang gagal karena kesalahan server tidak memotong limit. Sisa saldonya ada di header x-limit-extra." },
  { t: "Saat kuota dan limit habis", d: "API menjawab 429 sampai kuota harian terisi lagi, atau sampai kamu menaikkan paket atau membeli limit tambahan." },
  { t: "Bayar dengan QRIS", d: "Tagihan dibayar dari aplikasi bank atau e-wallet mana pun yang mendukung QRIS, dengan nominal persis seperti yang tampil di halaman bayar. Paket atau limit aktif otomatis begitu pembayaran masuk, biasanya dalam hitungan detik." },
];

export default function PaketPage() {
  return (
    <div>
      <header className="mb-8">
        <h1 className="font-mono text-[2rem] font-bold leading-tight tracking-tight">Paket</h1>
        <p className="mt-2 max-w-[65ch] text-muted">
          Semua endpoint bisa dipakai di paket mana pun. Ada dua cara menambah jatah permintaan: paket harian, atau limit tambahan yang dibeli sesuai kebutuhan.
        </p>
      </header>

      <PlanPanel
        plans={PLANS}
        dayChoices={PLAN_DAY_CHOICES}
        maxDays={MAX_PLAN_DAYS}
        limit={{ price: LIMIT_PRICE, step: LIMIT_STEP, min: LIMIT_MIN, max: LIMIT_MAX, choices: LIMIT_CHOICES }}
        total={allMeta().length}
        enabled={KEY_REQUIRED}
        authEnabled={AUTH_ENABLED}
        paymentReady={GATEWAY_READY}
        feeOnCustomer={FEE_ON_CUSTOMER}
        ownerUrl={APPEAL_URL}
      />

      <section aria-labelledby="paket-aturan" className="mt-12">
        <h2 id="paket-aturan" className="font-mono text-xl font-bold">
          Cara kerjanya
        </h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
          {notes.map((n) => (
            <div key={n.t} className="border-t border-line pt-4">
              <dt className="font-semibold">{n.t}</dt>
              <dd className="mt-1 text-muted">{n.d}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 text-muted">
          Pembayaran bermasalah, atau paket atau limit belum masuk setelah membayar?{" "}
          <a href={APPEAL_URL} target="_blank" rel="noreferrer" className="link font-medium text-fg">
            Hubungi owner lewat WhatsApp
          </a>{" "}
          dengan menyertakan nomor pesananmu.
        </p>
      </section>
    </div>
  );
}
