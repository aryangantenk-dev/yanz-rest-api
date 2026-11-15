"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChannelIcon, CloseIcon, ExternalIcon } from "./icons";
import { WHATSAPP_CHANNEL_NAME, WHATSAPP_CHANNEL_URL } from "@/lib/site";

/*
  Iklan pop-up saluran WhatsApp.

  Muncul sekali per kunjungan, 2,5 detik setelah halaman siap (bukan saat prerender, jadi
  tidak mengganggu LCP). Pilihan "Nanti saja" disimpan di localStorage selama HOLD_DAYS hari,
  sedangkan tombol tutup hanya menutup untuk kunjungan ini. Fokus keyboard dikurung di dalam
  dialog dan Esc menutupnya. Tanpa JavaScript, tidak ada yang tampil.
*/

const HOLD_KEY = "yanz.channelPromo.nanti";
const HOLD_DAYS = 3;

export function ChannelPromo() {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    // ?promo=1 menampilkan iklan tanpa menunggu dan tanpa menyimpan apa pun: dipakai untuk
    // meninjau tampilannya kapan saja.
    const force = new URLSearchParams(window.location.search).get("promo") === "1";
    let holdUntil = 0;
    if (!force) {
      try {
        holdUntil = Number(window.localStorage.getItem(HOLD_KEY) || 0);
      } catch {
        holdUntil = 0;
      }
    }
    if (holdUntil > Date.now()) return;
    const timer = window.setTimeout(() => {
      setOpen(true);
      setShown(true);
    }, force ? 300 : 2500);
    return () => window.clearTimeout(timer);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const later = useCallback(() => {
    try {
      window.localStorage.setItem(HOLD_KEY, String(Date.now() + HOLD_DAYS * 86_400_000));
    } catch {
      // Mode privat: cukup tutup untuk kunjungan ini.
    }
    close();
  }, [close]);

  // Esc menutup, Tab berputar di dalam dialog, dan fokus kembali ke elemen sebelumnya.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    dialog.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const start = items[0];
      const end = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === start || document.activeElement === dialog)) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        start.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, close]);

  if (!shown) return null;

  return (
    <div className={`promo-backdrop ${open ? "promo-open" : ""}`} aria-hidden={open ? undefined : true}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className="promo-card"
      >
        <button type="button" onClick={close} className="promo-close" aria-label="Tutup iklan">
          <CloseIcon />
        </button>

        <div className="promo-art" aria-hidden="true">
          <span className="promo-wordmark">yanz.api</span>
        </div>

        <div className="promo-body">
          <span className="promo-label">
            <ChannelIcon className="h-3.5 w-3.5" />
            Iklan
          </span>
          <h2 id={titleId} className="promo-title">
            Gabung saluran WhatsApp yanz.api
          </h2>
          <p id={descId} className="promo-desc">
            Dapatkan update endpoint terbaru, info maintenance, dan tips integrasi langsung ke WhatsApp kamu. Gratis &amp; tanpa spam.
          </p>

          <a
            href={WHATSAPP_CHANNEL_URL}
            target="_blank"
            rel="noopener"
            onClick={later}
            className="promo-cta"
          >
            <WhatsAppGlyph />
            Join saluran WhatsApp
            <ExternalIcon className="h-4 w-4 opacity-80" />
            <span className="sr-only">({WHATSAPP_CHANNEL_NAME}, terbuka di tab baru)</span>
          </a>

          <button type="button" onClick={later} className="promo-later">
            Nanti saja
          </button>
        </div>
      </div>
    </div>
  );
}

function WhatsAppGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true" fill="currentColor">
      <path d="M12.04 2c-5.46 0-9.9 4.44-9.9 9.9 0 1.75.46 3.45 1.32 4.95L2 22l5.3-1.39c1.45.79 3.08 1.2 4.74 1.2 5.46 0 9.9-4.44 9.9-9.9S17.5 2 12.04 2zm0 18.05c-1.5 0-2.97-.4-4.25-1.16l-.3-.18-3.14.82.84-3.07-.2-.32a8.14 8.14 0 0 1-1.25-4.34c0-4.51 3.67-8.18 8.19-8.18 4.51 0 8.18 3.67 8.18 8.18 0 4.52-3.67 8.19-8.18 8.19zm4.49-6.13c-.25-.12-1.47-.72-1.69-.81-.23-.08-.4-.12-.56.13-.17.25-.65.81-.79.97-.15.17-.29.19-.54.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.51.11-.11.25-.29.37-.44.12-.14.17-.25.25-.41.08-.17.04-.31-.02-.44-.06-.12-.56-1.35-.77-1.84-.2-.48-.41-.42-.56-.42h-.48c-.17 0-.44.06-.67.31-.23.25-.87.85-.87 2.07s.89 2.4 1.02 2.56c.12.17 1.75 2.67 4.23 3.74.59.25 1.05.4 1.41.52.59.19 1.13.16 1.56.1.47-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.15-1.18-.06-.11-.23-.17-.48-.29z" />
    </svg>
  );
}
