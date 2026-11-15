import { randomBytes } from "node:crypto";
import { supabaseRpc } from "@/db/store";
import { forgetAllKeys } from "@/lib/auth/apikey";
import { hit } from "@/lib/auth/limit";
import { GatewayError, getPayment, type Payment } from "./welper";

/* Pesanan paket (tabel api_orders dan fungsi plan_* di supabase/schema.sql). */

export type OrderStatus = "pending" | "paid" | "expired" | "canceled" | "failed";

export type Order = {
  id: string;
  user_id: string | null;
  plan: string;
  months: number;
  days: number;
  amount: number;
  total: number | null;
  fee: number | null;
  status: OrderStatus;
  gateway_ref: string;
  payment_url: string;
  expires_at: string | null;
  created_at: string;
  paid_at: string | null;
};

/** Bentuk pesanan yang dikirim ke browser pemiliknya. */
export function publicOrder(o: Order) {
  return {
    id: o.id,
    plan: o.plan,
    months: o.months,
    amount: o.amount,
    total: o.total,
    status: o.status,
    // Tautan bayar hanya berguna selama tagihannya masih menunggu.
    payment_url: o.status === "pending" ? o.payment_url : "",
    expires_at: o.expires_at,
    created_at: o.created_at,
    paid_at: o.paid_at,
  };
}

export const ORDER_ID_RE = /^YZ-[0-9A-Z]{6,12}-[0-9A-F]{10}$/;

/** Id pesanan baru; dipakai juga sebagai merchant_ref di gateway (huruf, angka, dan tanda hubung). */
export function newOrderId(): string {
  return `YZ-${Date.now().toString(36).toUpperCase()}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

export type Opened = { status: "ok"; reused: boolean; order: Order } | { status: "limit" };

export function orderOpen(id: string, userId: string, plan: string, months: number, days: number, amount: number): Promise<Opened> {
  return supabaseRpc<Opened>("plan_order_open", { p_id: id, p_user: userId, p_plan: plan, p_months: months, p_days: days, p_amount: amount });
}

export function orderAttach(id: string, pay: Payment): Promise<Order | null> {
  return supabaseRpc<Order | null>("plan_order_attach", { p_id: id, p_ref: pay.ref, p_url: pay.payment_url, p_total: pay.total, p_fee: pay.fee, p_expires: pay.expires_at });
}

export function orderGet(id: string): Promise<Order | null> {
  return supabaseRpc<Order | null>("plan_order_get", { p_id: id });
}

export function ordersOf(userId: string, limit = 10): Promise<Order[]> {
  return supabaseRpc<Order[] | null>("plan_orders", { p_user: userId, p_limit: limit }).then((r) => r ?? []);
}

export function orderClose(id: string, status: "expired" | "canceled" | "failed"): Promise<boolean> {
  return supabaseRpc<boolean>("plan_order_close", { p_id: id, p_status: status });
}

export type Paid = { status: "paid" | "already"; order: Order } | { status: "none" | "mismatch" };

/**
 * Tandai pesanan lunas dan aktifkan paketnya. Aman dipanggil berkali-kali (webhook bisa
 * terkirim ulang, dan halaman /paket juga memeriksa sendiri): paket hanya diaktifkan sekali.
 * `amount` adalah nominal menurut gateway dan harus sama dengan nominal pesanan.
 */
export async function orderPaid(id: string, gatewayRef: string, amount: number): Promise<Paid> {
  const res = await supabaseRpc<Paid>("plan_order_paid", { p_id: id, p_ref: gatewayRef, p_amount: amount });
  // Paket baru langsung berlaku di instance ini; instance lain menyusul paling lama satu menit.
  if (res.status === "paid") forgetAllKeys();
  return res;
}

/**
 * Cocokkan pesanan yang masih menunggu dengan statusnya di gateway. Dipakai halaman /paket
 * sebagai cadangan bila webhook terlambat atau tidak sampai. Paling sering sekali per 4 detik
 * untuk tiap pesanan; di antaranya, dan bila gateway sedang tidak bisa dihubungi, pesanan
 * dikembalikan apa adanya.
 */
export async function orderSync(order: Order): Promise<Order> {
  if (order.status !== "pending") return order;
  if (hit("order-sync", order.id, 1, 4_000)) return order;
  let pay: Payment;
  try {
    // Pesanan yang tagihannya belum sempat tersimpan dicari lewat id-nya (merchant_ref).
    pay = await getPayment(order.gateway_ref || order.id);
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    return order;
  }
  // Tagihan di gateway harus memang milik pesanan ini.
  if (pay.merchant_ref !== order.id) return order;
  if (pay.status === "paid") {
    const res = await orderPaid(order.id, pay.ref, pay.amount);
    return res.status === "paid" || res.status === "already" ? res.order : order;
  }
  if (pay.status === "expired" || pay.status === "canceled") {
    await orderClose(order.id, pay.status);
    return { ...order, status: pay.status };
  }
  return order;
}

export type AdminPlan = { email: string; username: string; plan: string; plan_expires_at: string | null };

export function adminSetPlan(email: string, plan: string, days: number): Promise<AdminPlan | null> {
  return supabaseRpc<AdminPlan | null>("plan_admin_set", { p_email: email, p_plan: plan, p_days: days });
}

export type AdminOrders = { paid: number; paid_amount: number; orders: Record<string, unknown>[] };

export function adminOrders(limit: number): Promise<AdminOrders> {
  return supabaseRpc<AdminOrders>("plan_admin_orders", { p_limit: limit });
}
