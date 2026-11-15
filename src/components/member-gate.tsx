"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { refreshAuth, useAuth, type AuthUser } from "./auth-client";
import { ArrowIcon } from "./icons";

/** Judul halaman area anggota: h1, keterangan singkat, dan tombol aksi di kanan. */
export function PageHead({ title, lead, children }: { title: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-mono text-[2rem] font-bold leading-tight tracking-tight">{title}</h1>
        {lead && <p className="wrap-anywhere mt-2 max-w-[65ch] text-muted">{lead}</p>}
      </div>
      {children && <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">{children}</div>}
    </header>
  );
}

function Card({ title, children, busy = false }: { title: string; children: ReactNode; busy?: boolean }) {
  return (
    <div className="border border-line bg-card p-5 sm:p-8" aria-busy={busy || undefined}>
      <h1 className="font-mono text-2xl font-bold tracking-tight sm:text-[2rem]">{title}</h1>
      {children}
    </div>
  );
}

/**
 * Penjaga halaman area anggota. Isi halaman baru digambar setelah akun masuk dan punya username;
 * sebelum itu yang tampil adalah keadaan yang sesuai: memuat, galat, ajakan masuk, atau ajakan memilih username.
 */
export function MemberGate({
  authEnabled = true,
  title,
  path,
  guest,
  off = "Login belum diaktifkan di server ini, jadi halaman ini belum bisa dipakai.",
  children,
}: {
  authEnabled?: boolean;
  /** Judul halaman, dipakai di semua keadaan sebelum isi tampil. */
  title: string;
  /** Alamat halaman ini; dibawa ke halaman masuk supaya pengguna kembali ke sini. */
  path: string;
  /** Kalimat ajakan untuk pengunjung yang belum masuk. */
  guest: string;
  off?: string;
  children: (user: AuthUser, apiKey: string) => ReactNode;
}) {
  const auth = useAuth(authEnabled);
  const next = encodeURIComponent(path);

  if (!authEnabled) {
    return (
      <Card title={title}>
        <p className="mt-3 max-w-[60ch] text-muted">{off}</p>
        <Link href="/docs" className="btn btn-secondary mt-6 w-full sm:w-auto">
          Buka dokumentasi
          <ArrowIcon />
        </Link>
      </Card>
    );
  }

  if (auth.status === "loading") {
    return (
      <div aria-busy="true">
        <p className="sr-only" role="status">
          Memuat {title.toLowerCase()}
        </p>
        <div className="space-y-6" aria-hidden>
          <div className="h-10 w-56 animate-pulse bg-subtle" />
          <div className="h-28 animate-pulse bg-subtle" />
          <div className="h-56 animate-pulse bg-subtle" />
        </div>
      </div>
    );
  }

  if (auth.status === "error" && !auth.user) {
    return (
      <Card title={`${title} belum bisa dimuat`}>
        <p role="alert" className="mt-3 text-muted">
          Server akun sedang tidak dapat dihubungi. Periksa koneksimu, lalu coba lagi.
        </p>
        <button type="button" onClick={() => void refreshAuth()} className="btn btn-primary mt-6 w-full sm:w-auto">
          Coba lagi
        </button>
      </Card>
    );
  }

  if (!auth.user) {
    return (
      <Card title={title}>
        <p id="dash-tamu" className="mt-3 max-w-[60ch] text-lg">
          {guest}
        </p>
        <Link href={`/login?next=${next}`} className="btn btn-primary mt-6 w-full sm:w-auto">
          Login
          <ArrowIcon />
        </Link>
        <p className="mt-4 flex flex-wrap items-center gap-x-2 border-t border-line pt-2 text-muted">
          Belum punya akun?
          <Link href={`/daftar?next=${next}`} className="link inline-flex min-h-11 items-center font-semibold text-fg">
            Daftar
          </Link>
        </p>
      </Card>
    );
  }

  if (auth.needsUsername || !auth.apiKey) {
    return (
      <Card title={title}>
        <p className="mt-3 max-w-[60ch] text-lg">Pilih username dulu. API key dan statistiknya baru aktif setelah username diisi.</p>
        <Link href={`/akun?next=${next}`} className="btn btn-primary mt-6 w-full sm:w-auto">
          Pilih username
          <ArrowIcon />
        </Link>
      </Card>
    );
  }

  return <>{children(auth.user, auth.apiKey)}</>;
}
