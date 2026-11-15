import type { Metadata } from "next";
import { PlanPanel } from "@/components/plan-panel";
import { allMeta } from "@/lib/api/registry";
import { AUTH_ENABLED, KEY_REQUIRED } from "@/lib/auth/config";
import { FEE_ON_CUSTOMER, GATEWAY_READY } from "@/lib/billing/welper";
import { APPEAL_URL } from "@/lib/guard";
import { FREE_PLAN, PLANS, PLAN_DAYS, PLAN_MONTHS, formatNumber } from "@/lib/plans";
import { SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: "Paket",
  description: `Pilihan paket ${SITE_NAME}: paket Gratis dengan ${formatNumber(FREE_PLAN.daily)} permintaan per hari, dan paket berbayar dengan kuota lebih besar yang dibayar lewat QRIS.`,
  alternates: { canonical: "/paket" },
};

const notes = [
  { t: "Kuota dihitung per akun", d: "Setiap permintaan ke /api yang membawa API key kamu mengurangi kuota harian akunmu, termasuk permintaan yang berakhir dengan galat. Mengganti API key tidak mengembalikan kuota." },
  { t: "Terisi lagi pukul 00.00 WIB", d: "Saat kuota habis, API menjawab 429 sampai tengah malam WIB. Sisa kuota ada di header x-quota-remaining pada setiap jawaban." },
  { t: `Satu masa aktif ${PLAN_DAYS} hari`, d: "Membeli lagi selagi paket masih aktif menambah masa aktifnya, bukan menimpanya. Tidak ada perpanjangan otomatis: setelah masa aktif habis akun kembali ke paket Gratis dengan sendirinya." },
  { t: "Bayar dengan QRIS", d: "Tagihan dibayar dari aplikasi bank atau e-wallet mana pun yang mendukung QRIS, dengan nominal persis seperti yang tampil di halaman bayar. Paket aktif otomatis begitu pembayaran masuk, biasanya dalam hitungan detik." },
];

export default function PaketPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-10 sm:px-6 sm:pt-16">
      <header className="mb-8">
        <h1 className="font-mono text-[2rem] font-bold leading-tight tracking-tight sm:text-[2.5rem]">Paket</h1>
        <p className="mt-3 max-w-[60ch] text-lg text-muted">
          Semua endpoint bisa dipakai di paket mana pun. Yang membedakan hanya banyaknya permintaan per hari dan per menit.
        </p>
      </header>

      <PlanPanel
        plans={PLANS}
        months={PLAN_MONTHS}
        planDays={PLAN_DAYS}
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
          Pembayaran bermasalah atau paket belum aktif setelah membayar?{" "}
          <a href={APPEAL_URL} target="_blank" rel="noreferrer" className="link font-medium text-fg">
            Hubungi owner lewat WhatsApp
          </a>{" "}
          dengan menyertakan nomor pesananmu.
        </p>
      </section>
    </div>
  );
}
