import { getStore } from "@/db/store";
import { pingWorker } from "@/lib/api/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getStore();
  const worker = await pingWorker();
  // Penyimpanan dan worker opsional: tanpa konfigurasi keduanya aplikasi tetap sehat.
  if (!store) return Response.json({ ok: true, database: "not_configured", worker: worker.status });
  try {
    await store.ping();
    return Response.json({ ok: true, database: "connected", backend: store.kind, worker: worker.status });
  } catch {
    return Response.json({ ok: false, database: "error", backend: store.kind, worker: worker.status }, { status: 500 });
  }
}
