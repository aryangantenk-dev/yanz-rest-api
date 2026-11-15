/** Pemberitahuan untuk pemilik akun yang API-nya sedang diblokir admin. Tidak menampilkan apa pun bila tidak diblokir. */
export function ApiBlockNotice({ block, className = "" }: { block: { until: string | null; reason: string } | null | undefined; className?: string }) {
  if (!block) return null;
  const until = block.until ? new Date(block.until) : null;
  const when = until ? until.toLocaleString("id-ID", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const reason = block.reason.replace(/[.\s]+$/, "");
  return (
    <section role="alert" className={`border border-danger bg-card p-4 sm:p-6 ${className}`}>
      <h2 className="font-mono text-lg font-bold text-danger">{until ? "API key kamu diblokir sementara" : "API key kamu diblokir permanen"}</h2>
      <p className="wrap-anywhere mt-2 max-w-[70ch]">
        {until ? (
          <>
            Admin memblokir API akun ini sampai <strong className="tnum font-semibold">{when}</strong>. Setelah itu API key bisa dipakai lagi tanpa perlu melakukan apa pun.
          </>
        ) : (
          "Admin memblokir API akun ini tanpa batas waktu."
        )}
      </p>
      {reason && (
        <p className="wrap-anywhere mt-2 max-w-[70ch]">
          <span className="text-muted">Alasan: </span>
          {reason}.
        </p>
      )}
      <p className="mt-2 max-w-[70ch] text-sm text-muted">Selama diblokir, semua permintaan dengan API key akun ini dijawab 403. Mengganti API key tidak membuka blokir. Untuk banding, hubungi admin.</p>
    </section>
  );
}
