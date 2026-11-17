import Link from "next/link";
import { ArrowIcon, CheckIcon } from "./icons";
import {
  FEATURED_BADGE,
  FEATURED_PLAN,
  LIMIT_PRICE,
  LIMIT_STEP,
  PLANS,
  PLAN_PITCH,
  formatNumber,
  rupiah,
  type Plan,
} from "@/lib/plans";

/**
 * Ringkasan harga di beranda: empat kartu paket harian lalu satu banner limit tambahan.
 * Angka dan teksnya dibaca dari src/lib/plans.ts supaya sama dengan halaman /paket.
 */

/** Fitur pembeda tiap paket, satu baris per poin. */
function perks(plan: Plan, total: number): string[] {
  const quota = plan.unlimited ? "Unlimited request/hari" : `${formatNumber(plan.daily)} request/hari`;
  return [quota, `Akses semua ${formatNumber(total)} endpoint`, ...planMeta[plan.id].extra];
}

const planMeta: Record<Plan["id"], { extra: string[] }> = {
  free: { extra: ["Reset otomatis 00.00 WIB", "CORS terbuka", "Tanpa kartu kredit"] },
  pro: { extra: ["Reset otomatis 00.00 WIB", "Aktivasi instan via QRIS"] },
  enterprise: { extra: ["Reset otomatis 00.00 WIB", "Prioritas kestabilan"] },
  bisnis: { extra: ["Reset otomatis 00.00 WIB", "Cocok untuk aplikasi trafik tinggi"] },
};

export function HomePricing({ total }: { total: number }) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((plan) => {
          const featured = plan.id === FEATURED_PLAN;
          const pitch = PLAN_PITCH[plan.id];
          const paid = plan.price > 0;
          return (
            <article
              key={plan.id}
              aria-labelledby={`harga-${plan.id}`}
              className={`relative flex flex-col border bg-card p-5 transition-transform duration-150 ${
                featured ? "border-[var(--accent-edge)] shadow-[0_10px_30px_-18px_var(--accent-edge)] lg:scale-[1.03]" : "border-line"
              }`}
            >
              {featured && (
                <p className="mb-3 inline-flex self-start bg-accent px-2 py-1 font-mono text-[0.6875rem] font-bold uppercase tracking-wide text-[var(--on-accent)]">
                  {FEATURED_BADGE}
                </p>
              )}
              <h3 id={`harga-${plan.id}`} className="font-mono text-lg font-bold tracking-tight">
                {plan.name}
              </h3>
              <p className="tnum mt-2 flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-mono text-[1.75rem] font-bold leading-none">{paid ? rupiah(plan.price) : "Rp0"}</span>
                {paid && <span className="text-sm text-muted">/ hari</span>}
              </p>
              <p className="mt-2 text-sm text-muted">{pitch.tagline}</p>
              {pitch.note && (
                <p className="mt-2 inline-flex self-start border border-[var(--accent-edge)] px-2 py-0.5 font-mono text-xs font-semibold text-ok">
                  {pitch.note}
                </p>
              )}

              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {perks(plan, total).map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <CheckIcon className="mt-0.5 shrink-0 text-ok" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>

              <Link
                href={plan.price === 0 ? "/daftar" : `/paket#paket-${plan.id}`}
                className={`mt-5 w-full ${featured ? "btn btn-primary" : "btn btn-secondary"}`}
              >
                {pitch.cta}
                <ArrowIcon />
              </Link>
            </article>
          );
        })}
      </div>

      {/* Limit tambahan: kuota cadangan yang tidak hangus. */}
      <div className="mt-4 flex flex-col gap-4 border border-[var(--accent-edge)] bg-subtle p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-xs font-bold uppercase tracking-wide text-ok">Kuota cadangan</p>
          <h3 className="mt-1 font-mono text-xl font-bold tracking-tight">Butuh kuota cadangan yang tidak hangus?</h3>
          <p className="mt-2 max-w-[70ch] text-muted">
            Top-up Limit Tambahan mulai{" "}
            <strong className="tnum font-semibold text-fg">
              {rupiah(LIMIT_PRICE * LIMIT_STEP)} per {formatNumber(LIMIT_STEP)} limit
            </strong>
            . Terpakai otomatis saat kuota harian habis dan <strong className="font-semibold text-fg">TIDAK PERNAH HANGUS</strong>{" "}
            selamanya.
          </p>
        </div>
        <Link href="/paket#paket-limit" className="btn btn-primary shrink-0">
          Beli Kuota Abadi
          <ArrowIcon />
        </Link>
      </div>

    </div>
  );
}
