"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CHAT_MAX_LENGTH, CHAT_PAGE, cleanChatText, type ChatMessage } from "@/lib/chat";
import { refreshAuth, type AuthUser } from "./auth-client";
import { Avatar } from "./avatar";
import { SendIcon, TrashIcon } from "./icons";
import { MemberGate, PageHead } from "./member-gate";

/*
  Chat global. Pesan baru diambil dengan bertanya ke server secara berkala (bukan sambungan terbuka),
  karena situs berjalan di fungsi serverless. Jedanya pendek selama obrolan ramai dan memanjang saat sepi,
  dan berhenti selama tab tidak terlihat.
*/

/** Jeda antarpertanyaan selama obrolan aktif. */
const POLL_MS = 5_000;
/** Jeda saat tidak ada pesan baru selama QUIET_AFTER_MS. */
const POLL_QUIET_MS = 15_000;
const QUIET_AFTER_MS = 120_000;
/** Saat gagal, jedanya digandakan sampai paling lama ini. */
const POLL_MAX_MS = 60_000;
/** Jarak minimum antara dua pembaruan yang dipicu oleh kembalinya fokus ke tab. */
const WAKE_GAP_MS = 2_000;
/** Setelah selama ini tidak berhasil memperbarui (mis. tab lama tersembunyi), daftar dimuat ulang dari awal supaya pesan yang sudah dihapus ikut hilang. */
const RELOAD_AFTER_MS = 5 * 60_000;
/** Pesan paling banyak yang disimpan di halaman; yang lebih lama dibuang dari tampilan. */
const MAX_SHOWN = 200;
/** Dianggap "di dasar" bila jarak ke pesan terakhir tidak lebih dari ini (px). */
const STICK_PX = 64;

type Body = { status?: boolean; error?: string; messages?: ChatMessage[]; removed?: number[]; message?: ChatMessage; id?: number };

/** Jam untuk pesan hari ini; tanggal dan jam untuk pesan yang lebih lama. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString("id-ID", { day: "numeric", month: "short" })}, ${time}`;
}

const fullStamp = (iso: string) => new Date(iso).toLocaleString("id-ID", { dateStyle: "full", timeStyle: "short" });

function Message({
  m,
  canDelete,
  confirming,
  removing,
  onAsk,
  onCancel,
  onDelete,
}: {
  m: ChatMessage;
  canDelete: boolean;
  confirming: boolean;
  removing: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex gap-3">
      <Avatar photo={m.photo} name={m.username} className="h-9 w-9 text-sm" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span className="wrap-anywhere font-mono font-semibold">@{m.username}</span>
          {m.admin && <span className="border border-ok px-1.5 text-xs font-semibold text-ok">Admin</span>}
          <time dateTime={m.at} title={fullStamp(m.at)} className="tnum text-xs text-muted">
            {stamp(m.at)}
          </time>
        </p>
        <p className="wrap-anywhere mt-1 whitespace-pre-wrap">{m.body}</p>
        {confirming && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Hapus pesan ini untuk semua orang?</span>
            <button type="button" onClick={onDelete} disabled={removing} className="btn btn-danger min-h-9 px-3 text-sm">
              {removing ? "Menghapus…" : "Hapus"}
            </button>
            <button type="button" onClick={onCancel} disabled={removing} className="btn btn-secondary min-h-9 px-3 text-sm">
              Batal
            </button>
          </div>
        )}
      </div>
      {canDelete && !confirming && (
        <button
          type="button"
          onClick={onAsk}
          aria-label={`Hapus pesan dari @${m.username}`}
          className="grid h-9 w-9 shrink-0 place-items-center text-muted transition-colors duration-150 hover:bg-subtle hover:text-danger"
        >
          <TrashIcon className="h-[18px] w-[18px]" />
        </button>
      )}
    </li>
  );
}

function ChatRoom({ user }: { user: AuthUser }) {
  /** null selama pesan pertama belum tiba. */
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  /** Pembaruan terakhir gagal (jaringan atau server). */
  const [stale, setStale] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  /** Pesan baru yang tiba selama pengguna sedang membaca pesan lama (tidak di dasar). */
  const [unseen, setUnseen] = useState(0);

  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** Pengguna sedang berada di dasar daftar: pesan baru langsung digulir ke tampilan. */
  const stick = useRef(true);
  /** Id terbesar yang sudah diterima dari server; pertanyaan berikutnya hanya meminta yang lebih baru. */
  const lastId = useRef(0);
  /** Id yang sudah ada di tampilan, supaya pesan sendiri (ditambahkan langsung saat terkirim) tidak dobel. */
  const seen = useRef(new Set<number>());
  const failures = useRef(0);
  const lastTry = useRef(0);
  const lastOk = useRef(0);
  const lastNews = useRef(0);
  const running = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  /** Sesi berakhir: berhenti bertanya, halaman akan menampilkan ajakan masuk. */
  const ended = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (ended.current) return;
    if (running.current) return running.current;
    const job = (async () => {
      lastTry.current = Date.now();
      const after = Date.now() - lastOk.current > RELOAD_AFTER_MS ? 0 : lastId.current;
      try {
        const r = await fetch(`/api/chat/messages?after=${after}`, { cache: "no-store", credentials: "same-origin" });
        const body = (await r.json().catch(() => ({}))) as Body;
        if (!alive.current) return;
        if (r.status === 401) {
          ended.current = true;
          void refreshAuth();
          return;
        }
        if (!r.ok || !Array.isArray(body.messages)) throw new Error(body.error || "gagal");

        const incoming = body.messages;
        const removed = new Set(body.removed ?? []);
        // Jawaban penuh berarti mungkin ada pesan di antaranya yang tidak ikut terkirim: mulai dari daftar baru.
        const reset = after === 0 || incoming.length >= CHAT_PAGE;
        if (reset) seen.current = new Set();
        const fresh = incoming.filter((m) => !seen.current.has(m.id));
        for (const m of fresh) seen.current.add(m.id);
        for (const id of removed) seen.current.delete(id);
        for (const m of incoming) if (m.id > lastId.current) lastId.current = m.id;

        failures.current = 0;
        lastOk.current = Date.now();
        setStale(false);
        if (fresh.length) lastNews.current = Date.now();
        if (reset) {
          setMessages(incoming);
        } else if (fresh.length || removed.size) {
          setMessages((prev) => [...(prev ?? []).filter((m) => !removed.has(m.id)), ...fresh].sort((a, b) => a.id - b.id).slice(-MAX_SHOWN));
          const others = fresh.filter((m) => m.username !== user.username).length;
          if (others && !stick.current) setUnseen((n) => n + others);
        }
      } catch {
        if (!alive.current) return;
        failures.current = Math.min(failures.current + 1, 6);
        setStale(true);
      }
    })().finally(() => {
      running.current = null;
    });
    running.current = job;
    return job;
  }, [user.username]);

  // Muat pesan saat halaman dibuka, lalu perbarui berkala selama tab terlihat.
  useEffect(() => {
    alive.current = true;
    lastNews.current = Date.now();
    let stopped = false;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (stopped || ended.current || document.visibilityState !== "visible") return;
      const base = Date.now() - lastNews.current > QUIET_AFTER_MS ? POLL_QUIET_MS : POLL_MS;
      timer = window.setTimeout(() => void refresh().then(schedule), Math.min(base * 2 ** failures.current, POLL_MAX_MS));
    };
    const wake = () => {
      if (document.visibilityState !== "visible") {
        window.clearTimeout(timer);
        return;
      }
      if (Date.now() - lastTry.current < WAKE_GAP_MS) return;
      void refresh().then(schedule);
    };
    void refresh().then(schedule);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      alive.current = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [refresh]);

  // Selama pengguna berada di dasar daftar, pesan baru langsung terlihat.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, confirmId]);

  function onScroll() {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
    if (stick.current && unseen) setUnseen(0);
  }

  function toBottom() {
    const el = box.current;
    stick.current = true;
    setUnseen(0);
    if (el) el.scrollTop = el.scrollHeight;
  }

  const text = cleanChatText(draft);
  const tooLong = text.length > CHAT_MAX_LENGTH;

  async function send() {
    if (sending || !text || tooLong) return;
    setSending(true);
    setNotice("");
    try {
      const r = await fetch("/api/chat/send", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const body = (await r.json().catch(() => ({}))) as Body;
      if (!alive.current) return;
      if (r.status === 401) {
        ended.current = true;
        void refreshAuth();
        return;
      }
      const sent = body.message;
      if (!r.ok || !sent) {
        setNotice(body.error || "Pesan belum terkirim. Coba lagi.");
        return;
      }
      setDraft("");
      lastNews.current = Date.now();
      stick.current = true;
      setUnseen(0);
      if (!seen.current.has(sent.id)) {
        seen.current.add(sent.id);
        setMessages((prev) => [...(prev ?? []), sent].sort((a, b) => a.id - b.id).slice(-MAX_SHOWN));
      }
      // Ambil juga pesan orang lain yang masuk tepat sebelum pesan ini.
      void refresh();
    } catch {
      if (alive.current) setNotice("Pesan belum terkirim. Periksa koneksimu, lalu coba lagi.");
    } finally {
      if (alive.current) {
        setSending(false);
        input.current?.focus();
      }
    }
  }

  function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    void send();
  }

  // Di perangkat berkeyboard, Enter mengirim dan Shift+Enter membuat baris baru. Di layar sentuh Enter tetap baris baru.
  function onKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    if (ev.key !== "Enter" || ev.shiftKey || ev.nativeEvent.isComposing) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    ev.preventDefault();
    void send();
  }

  async function remove(id: number) {
    if (removingId !== null) return;
    setRemovingId(id);
    setNotice("");
    try {
      const r = await fetch("/api/chat/delete", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const body = (await r.json().catch(() => ({}))) as Body;
      if (!alive.current) return;
      if (r.status === 401) {
        ended.current = true;
        void refreshAuth();
        return;
      }
      // 404: pesannya sudah dihapus lebih dulu (mis. oleh admin), jadi hasilnya sama.
      if (r.ok || r.status === 404) {
        seen.current.delete(id);
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== id));
        setConfirmId(null);
      } else {
        setNotice(body.error || "Pesan belum terhapus. Coba lagi.");
      }
    } catch {
      if (alive.current) setNotice("Pesan belum terhapus. Periksa koneksimu, lalu coba lagi.");
    } finally {
      if (alive.current) setRemovingId(null);
    }
  }

  const loading = messages === null && !stale;
  const loadFailed = messages === null && stale;

  return (
    <section aria-label="Ruang chat global" className="border border-line bg-card">
      <div className="relative">
        <div
          ref={box}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-label="Pesan chat global"
          aria-busy={loading || undefined}
          tabIndex={0}
          className="h-[min(60dvh,34rem)] overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
        >
          {loading && (
            <div aria-hidden className="space-y-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3">
                  <div className="h-9 w-9 shrink-0 animate-pulse bg-subtle" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 animate-pulse bg-subtle" />
                    <div className="h-4 w-3/4 animate-pulse bg-subtle" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {loadFailed && (
            <div className="grid h-full place-items-center text-center">
              <div>
                <p className="text-muted">Pesan belum bisa dimuat. Periksa koneksimu.</p>
                <button type="button" onClick={() => void refresh()} className="btn btn-secondary mt-4">
                  Coba lagi
                </button>
              </div>
            </div>
          )}
          {messages && messages.length === 0 && (
            <div className="grid h-full place-items-center text-center">
              <p className="max-w-[40ch] text-muted">Belum ada pesan. Jadilah yang pertama menyapa.</p>
            </div>
          )}
          {messages && messages.length > 0 && (
            <ol className="space-y-4">
              {messages.map((m) => (
                <Message
                  key={m.id}
                  m={m}
                  canDelete={user.admin === true || m.username === user.username}
                  confirming={confirmId === m.id}
                  removing={removingId === m.id}
                  onAsk={() => setConfirmId(m.id)}
                  onCancel={() => setConfirmId(null)}
                  onDelete={() => void remove(m.id)}
                />
              ))}
            </ol>
          )}
        </div>
        {unseen > 0 && (
          <button type="button" onClick={toBottom} className="btn btn-primary absolute bottom-3 left-1/2 min-h-9 -translate-x-1/2 px-4 text-sm">
            {unseen} pesan baru
          </button>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-line p-4 sm:p-5">
        <label htmlFor="chat-pesan" className="sr-only">
          Pesan
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="chat-pesan"
            ref={input}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            // Sedikit di atas batas, supaya menempel teks panjang menampilkan penghitung merah alih-alih terpotong diam-diam.
            maxLength={CHAT_MAX_LENGTH * 2}
            placeholder="Tulis pesan…"
            enterKeyHint="send"
            aria-invalid={tooLong || undefined}
            aria-describedby="chat-bantuan chat-galat"
            className="field resize-none"
            style={{ fontFamily: "inherit" }}
          />
          <button type="submit" disabled={sending || !text || tooLong} aria-label="Kirim pesan" className="btn btn-primary shrink-0 px-4">
            <SendIcon />
            <span className="hidden sm:inline">{sending ? "Mengirim…" : "Kirim"}</span>
          </button>
        </div>
        <div className="mt-2 flex items-start justify-between gap-3 text-xs text-muted">
          <p id="chat-bantuan">
            <span className="pointer-coarse:hidden">Enter untuk mengirim, Shift+Enter untuk baris baru. </span>
            {stale && messages ? "Gagal memperbarui, dicoba lagi otomatis." : "Pesan baru muncul otomatis."}
          </p>
          <p className={`tnum shrink-0 ${tooLong ? "font-semibold text-danger" : ""}`}>
            {text.length}/{CHAT_MAX_LENGTH}
          </p>
        </div>
        <p id="chat-galat" role="alert" className={notice ? "mt-3 border border-danger p-3 text-sm font-medium text-danger" : "sr-only"}>
          {notice}
        </p>
      </form>
    </section>
  );
}

export function ChatPanel({ authEnabled }: { authEnabled: boolean }) {
  return (
    <MemberGate authEnabled={authEnabled} title="Chat global" path="/chat" guest="Kamu belum login, login dahulu untuk ikut mengobrol di chat global.">
      {(user) => (
        <div className="space-y-6">
          <PageHead title="Chat global" lead="Ruang obrolan untuk semua anggota yanz.api. Jangan bagikan API key atau data pribadi di sini; admin dapat menghapus pesan." />
          <ChatRoom user={user} />
        </div>
      )}
    </MemberGate>
  );
}
