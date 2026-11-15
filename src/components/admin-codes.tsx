"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge, ConfirmButton, call } from "./admin-shared";
import { CopyButton } from "./client-utils";

type PlanOption = { id: string; name: string; paid: boolean };
type CodeRow = {
  code: string;
  plan: string;
  days: number;
  qty: number;
  max_uses: number | null;
  used: number;
  expires_at: string | null;
  note: string;
  created_at: string;
  recent?: { who: string; used_at: string }[];
};
type Codes = { total: number; codes: CodeRow[] };
type Notice = { tone: "ok" | "danger"; text: string };

const nf = new Intl.NumberFormat("id-ID");
const fmt = (n: number | undefined | null) => nf.format(Number(n) || 0);
const moment = (iso: string) => new Date(iso).toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const CODE_RE = /^[0-9A-Z][0-9A-Z-]{2,30}[0-9A-Z]$/;
const whole = (s: string, max: number) => /^\d{1,9}$/.test(s) && Number(s) <= max;

/** Tab "Kode" di panel admin: buat kode hadiah (paket, limit, atau keduanya) dan lihat pemakaiannya. */
export function AdminCodes({ plans }: { plans: PlanOption[] }) {
  const paid = plans.filter((p) => p.paid);
  const [data, setData] = useState<Codes | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState("");
  /** Jam yang dipakai menilai "sudah lewat"; diperbarui saat daftar dimuat dan saat tanggal diubah. */
  const [now, setNow] = useState(() => Date.now());

  const [code, setCode] = useState("");
  const [plan, setPlan] = useState("");
  const [days, setDays] = useState("7");
  const [qty, setQty] = useState("");
  const [max, setMax] = useState("");
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");

  const alive = useRef(true);
  const ids = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const r = await call<Codes>("codes");
    if (!alive.current) return;
    setNow(Date.now());
    if (r.result) setData(r.result);
    setError(r.ok ? "" : r.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- memuat daftar kode saat tab dibuka
    void load();
  }, [load]);

  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? id;
  /** Isi sebuah kode dalam kata-kata. */
  const contents = (c: { plan: string; days: number; qty: number }) =>
    [c.plan && c.days > 0 ? `Paket ${planName(c.plan)} ${fmt(c.days)} hari` : "", c.qty > 0 ? `${fmt(c.qty)} limit tambahan` : ""].filter(Boolean).join(" + ");

  const codeClean = code.replace(/\s+/g, "").toUpperCase();
  const codeOk = !codeClean || CODE_RE.test(codeClean);
  const daysOk = !plan || (whole(days, 3650) && Number(days) >= 1);
  const qtyOk = !qty || whole(qty, 10_000_000);
  const hasContent = !!plan || (!!qty && Number(qty) > 0);
  const maxOk = !max || (whole(max, 1_000_000) && Number(max) >= 1);
  const untilAt = until ? new Date(until).getTime() : NaN;
  const untilOk = !until || (Number.isFinite(untilAt) && untilAt > now + 60_000);
  const formOk = codeOk && daysOk && qtyOk && hasContent && maxOk && untilOk;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!formOk || busy) return;
    setBusy("create");
    setNotice(null);
    setMade("");
    const params: Record<string, string> = {};
    if (codeClean) params.code = codeClean;
    if (plan) {
      params.plan = plan;
      params.days = days;
    }
    if (qty && Number(qty) > 0) params.limit = qty;
    if (max) params.max = max;
    if (until) params.expires = new Date(until).toISOString();
    if (note.trim()) params.note = note.trim();
    const r = await call<CodeRow & { message?: string }>("codecreate", params);
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok || !r.result) {
      setNotice({ tone: "danger", text: r.error || "Kode gagal dibuat. Coba lagi." });
      return;
    }
    setMade(r.result.code);
    setNotice({ tone: "ok", text: `Kode ${r.result.code} dibuat: ${contents(r.result)}.` });
    setCode("");
    setNote("");
    await load();
  }

  async function remove(c: CodeRow) {
    setBusy(`del:${c.code}`);
    setNotice(null);
    const r = await call<{ message?: string }>("codedelete", { code: c.code });
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok) {
      setNotice({ tone: "danger", text: r.error });
      return;
    }
    if (made === c.code) setMade("");
    setNotice({ tone: "ok", text: `Kode ${c.code} dihapus.` });
    await load();
  }

  return (
    <section>
      <p role="status" aria-live="polite" className={notice ? `mb-4 border p-3 font-medium ${notice.tone === "danger" ? "border-danger text-danger" : "border-[var(--accent-edge)] bg-card text-fg"}` : "sr-only"}>
        {notice?.text}
      </p>
      {made && (
        <div className="mb-4 flex items-stretch border border-control bg-bg">
          <code className="wrap-anywhere min-w-0 flex-1 self-center px-3 py-2 font-mono text-base font-semibold">{made}</code>
          <CopyButton text={made} />
        </div>
      )}

      <form onSubmit={create} className="border border-line bg-card p-4 sm:p-6">
        <h2 className="font-mono text-lg font-bold">Buat kode</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">Kode ditukar pengguna di halaman Paket. Isinya bisa paket, limit tambahan, atau keduanya. Satu akun hanya bisa menukar satu kode sekali.</p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${ids}-plan`} className="block text-sm font-medium">
              Paket
            </label>
            <select id={`${ids}-plan`} value={plan} onChange={(e) => setPlan(e.target.value)} className="field mt-1">
              <option value="">Tanpa paket</option>
              {paid.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${ids}-days`} className="block text-sm font-medium">
              Lama paket (hari)
            </label>
            <input
              id={`${ids}-days`}
              inputMode="numeric"
              autoComplete="off"
              value={plan ? days : ""}
              onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 4))}
              disabled={!plan}
              aria-invalid={!daysOk}
              aria-describedby={`${ids}-days-help`}
              className="field tnum mt-1 disabled:opacity-50"
            />
            <p id={`${ids}-days-help`} className={`mt-1 text-sm ${daysOk ? "text-muted" : "font-medium text-danger"}`}>
              {daysOk ? "Ditambahkan ke masa aktif bila penukar sudah memakai paket yang sama." : "Isi jumlah hari dari 1 sampai 3650."}
            </p>
          </div>
          <div>
            <label htmlFor={`${ids}-qty`} className="block text-sm font-medium">
              Limit tambahan (permintaan)
            </label>
            <input
              id={`${ids}-qty`}
              inputMode="numeric"
              autoComplete="off"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 8))}
              placeholder="0"
              aria-invalid={!qtyOk || !hasContent}
              aria-describedby={`${ids}-qty-help`}
              className="field tnum mt-1"
            />
            <p id={`${ids}-qty-help`} className={`mt-1 text-sm ${qtyOk && hasContent ? "text-muted" : "font-medium text-danger"}`}>
              {!qtyOk ? "Paling banyak 10.000.000." : hasContent ? "Kosongkan bila kode hanya berisi paket." : "Pilih paket, isi limit, atau keduanya."}
            </p>
          </div>
          <div>
            <label htmlFor={`${ids}-max`} className="block text-sm font-medium">
              Kuota penukaran
            </label>
            <input
              id={`${ids}-max`}
              inputMode="numeric"
              autoComplete="off"
              value={max}
              onChange={(e) => setMax(e.target.value.replace(/\D/g, "").slice(0, 7))}
              placeholder="Tidak terbatas"
              aria-invalid={!maxOk}
              aria-describedby={`${ids}-max-help`}
              className="field tnum mt-1"
            />
            <p id={`${ids}-max-help`} className={`mt-1 text-sm ${maxOk ? "text-muted" : "font-medium text-danger"}`}>
              {maxOk ? "Berapa akun yang boleh menukar kode ini. Kosongkan untuk tidak terbatas." : "Isi 1 sampai 1.000.000, atau kosongkan."}
            </p>
          </div>
          <div>
            <label htmlFor={`${ids}-until`} className="block text-sm font-medium">
              Kode berlaku sampai
            </label>
            <input id={`${ids}-until`} type="datetime-local" value={until} onChange={(e) => {
                setUntil(e.target.value);
                setNow(Date.now());
              }} aria-invalid={!untilOk} aria-describedby={`${ids}-until-help`} className="field tnum mt-1" />
            <p id={`${ids}-until-help`} className={`mt-1 text-sm ${untilOk ? "text-muted" : "font-medium text-danger"}`}>
              {untilOk ? "Menurut jam di perangkatmu. Kosongkan bila kode tidak kedaluwarsa." : "Pilih waktu yang masih akan datang."}
            </p>
          </div>
          <div>
            <label htmlFor={`${ids}-code`} className="block text-sm font-medium">
              Kode (opsional)
            </label>
            <input
              id={`${ids}-code`}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, "").slice(0, 32))}
              placeholder="Dibuat otomatis"
              aria-invalid={!codeOk}
              aria-describedby={`${ids}-code-help`}
              className="field mt-1 font-mono"
            />
            <p id={`${ids}-code-help`} className={`mt-1 text-sm ${codeOk ? "text-muted" : "font-medium text-danger"}`}>
              {codeOk ? "Mis. MERDEKA17. Kosongkan agar dibuat acak." : "4 sampai 32 karakter: huruf, angka, dan tanda hubung di tengah."}
            </p>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`${ids}-note`} className="block text-sm font-medium">
              Catatan (opsional)
            </label>
            <input id={`${ids}-note`} autoComplete="off" value={note} onChange={(e) => setNote(e.target.value.slice(0, 120))} aria-describedby={`${ids}-note-help`} className="field mt-1" />
            <p id={`${ids}-note-help`} className="mt-1 text-sm text-muted">
              Hanya terlihat di panel ini, mis. untuk siapa kode ini dibuat.
            </p>
          </div>
        </div>
        <button type="submit" disabled={!formOk || !!busy} className="btn btn-primary mt-5">
          {busy === "create" ? "Membuat…" : "Buat kode"}
        </button>
      </form>

      <h2 className="mt-8 font-mono text-lg font-bold">Daftar kode{data ? ` (${fmt(data.total)})` : ""}</h2>
      {error && (
        <div className="mt-3 flex flex-col gap-3 border border-danger p-3 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <p className="font-medium text-danger">{error}</p>
          <button type="button" onClick={() => void load()} className="btn btn-secondary shrink-0">
            Coba lagi
          </button>
        </div>
      )}
      {!data && !error && <div className="mt-3 h-32 animate-pulse bg-subtle" aria-hidden />}
      {data && data.codes.length === 0 && <p className="mt-3 border border-control bg-card p-4 text-muted">Belum ada kode. Buat kode pertama lewat formulir di atas.</p>}
      {data && data.codes.length > 0 && (
        <ul className="mt-3 space-y-3">
          {data.codes.map((c) => {
            const expired = !!c.expires_at && Date.parse(c.expires_at) <= now;
            const usedUp = c.max_uses !== null && c.used >= c.max_uses;
            return (
              <li key={c.code} className="border border-line bg-card p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <code className="wrap-anywhere font-mono text-base font-semibold">{c.code}</code>
                  {expired ? <Badge tone="danger">Kedaluwarsa</Badge> : usedUp ? <Badge tone="danger">Habis</Badge> : <Badge tone="ok">Aktif</Badge>}
                </div>
                <dl className="tnum mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-muted sm:inline">Isi: </dt>
                    <dd className="sm:inline">{contents(c)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-muted sm:inline">Ditukar: </dt>
                    <dd className="sm:inline">{c.max_uses === null ? `${fmt(c.used)} kali, tidak terbatas` : `${fmt(c.used)} dari ${fmt(c.max_uses)}`}</dd>
                  </div>
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-muted sm:inline">Berlaku sampai: </dt>
                    <dd className="sm:inline">{c.expires_at ? moment(c.expires_at) : "Tidak kedaluwarsa"}</dd>
                  </div>
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-muted sm:inline">Dibuat: </dt>
                    <dd className="sm:inline">{moment(c.created_at)}</dd>
                  </div>
                </dl>
                {c.note && <p className="wrap-anywhere mt-2 text-sm text-muted">Catatan: {c.note}</p>}
                {c.recent && c.recent.length > 0 && (
                  <p className="wrap-anywhere mt-2 text-sm text-muted">
                    Penukar terakhir: {c.recent.map((r) => (r.who.includes("@") ? r.who : `@${r.who}`)).join(", ")}
                    {c.used > c.recent.length ? `, dan ${fmt(c.used - c.recent.length)} lainnya` : ""}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <CopyButton text={c.code} label="Salin kode" className="border border-control" />
                  <ConfirmButton label="Hapus" confirmLabel="Ya, hapus kode ini" onConfirm={() => void remove(c)} disabled={!!busy} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
