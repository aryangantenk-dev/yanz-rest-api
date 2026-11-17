"use client";

import { MoonIcon, SunIcon } from "./icons";

/** Tombol tema: ikon diatur lewat CSS (.only-light / .only-dark), jadi tidak perlu state. */
export function ThemeToggle() {
  return (
    <button
      type="button"
      aria-label="Ganti tema terang atau gelap"
      title="Ganti tema"
      onClick={() => {
        const root = document.documentElement;
        const next = getComputedStyle(root).colorScheme.includes("dark") ? "light" : "dark";
        root.dataset.theme = next;
        try {
          localStorage.setItem("theme", next);
        } catch {
          /* penyimpanan diblokir: tema tetap berganti untuk sesi ini */
        }
      }}
      className="grid h-11 w-11 shrink-0 place-items-center text-muted transition-colors duration-150 hover:bg-subtle hover:text-fg"
    >
      <MoonIcon className="only-light" />
      <SunIcon className="only-dark" />
    </button>
  );
}
