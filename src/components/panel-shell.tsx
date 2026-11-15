"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { signOut, useAuth } from "./auth-client";
import { Avatar } from "./avatar";
import {
  BanIcon,
  BookIcon,
  BoxIcon,
  CardIcon,
  ChartIcon,
  ClockIcon,
  CloseIcon,
  GiftIcon,
  HomeIcon,
  KeyIcon,
  LockIcon,
  LogoMark,
  LogoutIcon,
  MenuIcon,
  ReceiptIcon,
  ShieldIcon,
  TicketIcon,
  UserIcon,
  UsersIcon,
} from "./icons";
import { ThemeToggle } from "./theme-toggle";

type Item = { href: string; label: string; icon: (p: { className?: string }) => ReactNode };
type Group = { id: string; title: string; items: Item[] };

/** Halaman area anggota. Tiap bagian punya halamannya sendiri; menu ini satu-satunya daftar lengkapnya. */
const MEMBER: Group = {
  id: "anggota",
  title: "Akun saya",
  items: [
    { href: "/dashboard", label: "Dashboard", icon: ChartIcon },
    { href: "/dashboard/riwayat", label: "Riwayat", icon: ClockIcon },
    { href: "/dashboard/api-key", label: "API key", icon: KeyIcon },
    { href: "/paket", label: "Paket", icon: BoxIcon },
    { href: "/dashboard/undang", label: "Undang teman", icon: GiftIcon },
    { href: "/akun", label: "Akun", icon: UserIcon },
  ],
};

const ADMIN: Group = {
  id: "admin",
  title: "Admin",
  items: [
    { href: "/admin", label: "Ringkasan", icon: ChartIcon },
    { href: "/admin/akun", label: "Akun pengguna", icon: UsersIcon },
    { href: "/admin/pesanan", label: "Pesanan", icon: ReceiptIcon },
    { href: "/admin/kode", label: "Kode", icon: TicketIcon },
    { href: "/admin/blokir-ip", label: "Blokir IP", icon: ShieldIcon },
    { href: "/admin/blokir-api", label: "Blokir API", icon: LockIcon },
    { href: "/admin/blokir-endpoint", label: "Blokir endpoint", icon: BanIcon },
    { href: "/admin/pembayaran", label: "Pembayaran", icon: CardIcon },
  ],
};

const SITE: Group = {
  id: "situs",
  title: "Situs",
  items: [
    { href: "/docs", label: "Dokumentasi", icon: BookIcon },
    { href: "/", label: "Beranda", icon: HomeIcon },
  ],
};

function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <Link href="/" onClick={onClick} className="flex min-h-11 items-center gap-2.5" aria-label="yanz.api, ke beranda">
      <LogoMark className="h-7 w-7" />
      <span className="font-mono text-lg font-bold tracking-tight">
        yanz<span className="text-ok">.</span>api
      </span>
    </Link>
  );
}

/**
 * Kerangka area anggota (dashboard, paket, akun, admin): menu samping di layar lebar,
 * bilah atas dengan menu yang dibuka-tutup di layar kecil. Terpisah dari header beranda dan dokumentasi.
 */
export function PanelShell({ authEnabled, children }: { authEnabled: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const auth = useAuth(authEnabled);
  // Menu seluler terikat ke halaman tempat ia dibuka, jadi otomatis tertutup saat berpindah halaman.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const [leaving, setLeaving] = useState(false);
  const close = () => setOpenAt(null);

  useEffect(() => {
    if (!open) return;
    const on = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpenAt(null);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open]);

  // Menu Admin hanya untuk akun admin; halaman dan endpoint-nya tetap memeriksa sendiri di server.
  const groups = auth.user?.admin ? [MEMBER, ADMIN, SITE] : [MEMBER, SITE];
  const current = [...MEMBER.items, ...ADMIN.items].find((i) => i.href === pathname);

  async function logout() {
    setLeaving(true);
    const ok = await signOut();
    if (ok) router.replace("/login");
    else setLeaving(false);
  }

  return (
    <div className="flex min-h-dvh flex-1 flex-col lg:pl-64">
      {/* Bilah atas: hanya di layar kecil. Di layar lebar logonya ada di menu samping. */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-line bg-bg lg:hidden">
        <div className="flex h-[var(--header-h)] items-center justify-between gap-3 px-4 sm:px-6">
          <Logo onClick={close} />
          <div className="flex min-w-0 items-center gap-2">
            {current && <span className="hidden truncate text-sm text-muted sm:block">{current.label}</span>}
            <ThemeToggle />
            <button
              type="button"
              aria-label={open ? "Tutup menu" : "Buka menu"}
              aria-expanded={open}
              aria-controls="menu-panel"
              onClick={() => setOpenAt(open ? null : pathname)}
              className="grid h-11 w-11 place-items-center border border-control text-fg transition-colors duration-150 hover:bg-subtle"
            >
              {open ? <CloseIcon /> : <MenuIcon />}
            </button>
          </div>
        </div>
      </header>

      <aside
        id="menu-panel"
        data-open={open}
        className={`fixed inset-x-0 bottom-0 top-[var(--header-h)] z-40 flex-col overflow-y-auto overscroll-contain bg-bg lg:inset-y-0 lg:right-auto lg:flex lg:w-64 lg:border-r lg:border-line lg:bg-card ${open ? "flex" : "hidden"}`}
      >
        <div className="hidden h-[var(--header-h)] shrink-0 items-center justify-between border-b border-line pl-5 pr-2 lg:flex">
          <Logo />
          <ThemeToggle />
        </div>

        <nav aria-label="Menu area anggota" className="flex-1 px-3 py-4">
          {groups.map((g) => (
            <div key={g.id} className="mb-5 last:mb-0">
              <h2 id={`menu-${g.id}`} className="px-3 pb-1.5 font-mono text-xs font-bold uppercase tracking-wider text-muted">
                {g.title}
              </h2>
              <ul aria-labelledby={`menu-${g.id}`}>
                {g.items.map((i) => {
                  const active = i.href === pathname;
                  return (
                    <li key={i.href}>
                      <Link
                        href={i.href}
                        onClick={close}
                        aria-current={active ? "page" : undefined}
                        className={`relative flex min-h-11 items-center gap-3 px-3 text-[0.9375rem] transition-colors duration-150 ${active ? "bg-subtle font-semibold text-fg" : "text-muted hover:bg-subtle hover:text-fg"}`}
                      >
                        {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
                        <i.icon className="shrink-0" />
                        {i.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {authEnabled && (
          <div className="shrink-0 border-t border-line p-3">
            {/* Salah satu saja yang tampil, dipilih CSS menurut status login (lihat .only-signed di globals.css). */}
            <div className="only-guest flex flex-col gap-2">
              <Link href={`/login?next=${encodeURIComponent(pathname)}`} onClick={close} className="btn btn-primary w-full">
                Masuk
              </Link>
              <Link href={`/daftar?next=${encodeURIComponent(pathname)}`} onClick={close} className="btn btn-secondary w-full">
                Daftar
              </Link>
            </div>
            <div className="only-signed w-full flex-col gap-2">
              <Link href="/akun" onClick={close} className="flex min-h-11 min-w-0 items-center gap-3 px-2 hover:bg-subtle">
                <Avatar photo={auth.user?.photo ?? ""} name={auth.user?.username ?? ""} className="h-9 w-9 shrink-0 text-sm" />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-sm font-semibold">{auth.user?.username ? `@${auth.user.username}` : "Akun"}</span>
                  <span className="block truncate text-xs text-muted">{auth.user?.email ?? ""}</span>
                </span>
              </Link>
              <button type="button" onClick={() => void logout()} disabled={leaving || !auth.user} className="btn btn-secondary w-full">
                <LogoutIcon />
                {leaving ? "Keluar…" : "Keluar"}
              </button>
            </div>
          </div>
        )}
      </aside>

      <main id="konten" tabIndex={-1} className="flex-1 pt-[var(--header-h)] outline-none lg:pt-0">
        <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6 lg:px-10 lg:pt-10">{children}</div>
      </main>
    </div>
  );
}
