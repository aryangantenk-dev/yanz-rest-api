-- Skema yanz.api untuk Supabase (backend REST).
-- Jalankan sekali di SQL Editor Supabase. Aman dijalankan ulang.
--
-- RLS aktif tanpa policy, jadi tabel hanya bisa diakses dengan service role /
-- secret key (yang hanya dipakai di server), bukan dengan anon key.

create table if not exists public.api_stats (
  path varchar(120) primary key,
  hits integer not null default 0,
  updated_at timestamp not null default now()
);

create table if not exists public.short_links (
  id serial primary key,
  code varchar(16) not null unique,
  url text not null,
  hits integer not null default 0,
  created_at timestamp not null default now()
);

create index if not exists short_links_url_idx on public.short_links using hash (url);

-- IP yang diblokir karena melewati batas permintaan berulang kali.
-- Buka blokir: hapus barisnya di sini, atau panggil /api/admin/unban.
create table if not exists public.banned_ips (
  ip varchar(64) primary key,
  reason text not null default '',
  created_at timestamp not null default now()
);

alter table public.banned_ips enable row level security;
alter table public.api_stats enable row level security;
alter table public.short_links enable row level security;

create or replace function public.record_api_hit(p_path text)
returns void
language sql
set search_path = ''
as $$
  insert into public.api_stats (path, hits)
  values (left(p_path, 120), 1)
  on conflict (path) do update set hits = public.api_stats.hits + 1, updated_at = now();
$$;

create or replace function public.api_stats_summary()
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'totalRequests', (select coalesce(sum(hits), 0)::int from public.api_stats),
    'top', (select coalesce(json_agg(t), '[]'::json) from (select path, hits from public.api_stats order by hits desc limit 5) t)
  );
$$;

-- Mengembalikan kode milik p_url; membuatnya dengan p_code bila belum ada.
-- Mengembalikan null bila p_code sudah dipakai URL lain (pemanggil mencoba kode baru).
create or replace function public.shorten_url(p_url text, p_code text)
returns json
language plpgsql
set search_path = ''
as $$
declare
  r record;
begin
  select code, hits into r from public.short_links where url = p_url limit 1;
  if found then
    return json_build_object('code', r.code, 'hits', r.hits);
  end if;
  insert into public.short_links (code, url) values (p_code, p_url);
  return json_build_object('code', p_code, 'hits', 0);
exception when unique_violation then
  return null;
end;
$$;

create or replace function public.resolve_short_link(p_code text)
returns text
language sql
set search_path = ''
as $$
  update public.short_links set hits = hits + 1 where code = p_code returning url;
$$;

revoke all on function public.record_api_hit(text) from public, anon, authenticated;
revoke all on function public.api_stats_summary() from public, anon, authenticated;
revoke all on function public.shorten_url(text, text) from public, anon, authenticated;
revoke all on function public.resolve_short_link(text) from public, anon, authenticated;
grant execute on function public.record_api_hit(text) to service_role;
grant execute on function public.api_stats_summary() to service_role;
grant execute on function public.shorten_url(text, text) to service_role;
grant execute on function public.resolve_short_link(text) to service_role;

-- ---------------------------------------------------------------------------
-- Akun pengguna dan API key (login Google / email + kode OTP).
-- Hanya dipakai lewat fungsi di bawah, dengan service role dari server.
-- ---------------------------------------------------------------------------

create table if not exists public.api_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null default '',
  avatar text not null default '',
  -- Cara masuk saat akun dibuat: 'google' atau 'email'.
  provider text not null default 'email',
  api_key text not null unique,
  banned boolean not null default false,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  key_rotated_at timestamptz
);

-- Satu baris per alamat email. Kodenya tidak disimpan, hanya hash-nya.
create table if not exists public.auth_otps (
  email text primary key,
  code_hash text not null default '',
  expires_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_sent_at timestamptz not null default now(),
  window_start timestamptz not null default now(),
  window_sends integer not null default 1,
  ip text not null default ''
);

create index if not exists auth_otps_last_sent_idx on public.auth_otps (last_sent_at);

-- Username (wajib diisi sebelum akun dipakai; null selama belum dipilih) dan foto profil
-- (opsional; nama berkas di folder avatars/ pada bucket gambar, kosong berarti belum diatur).
alter table public.api_users add column if not exists username text;
alter table public.api_users add column if not exists photo text not null default '';
create unique index if not exists api_users_username_key on public.api_users (username);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_users_username_format') then
    alter table public.api_users add constraint api_users_username_format
      check (username is null or username ~ '^[a-z][a-z0-9_]{2,19}$');
  end if;
end
$$;

alter table public.api_users enable row level security;
alter table public.auth_otps enable row level security;
revoke all on table public.api_users from anon, authenticated;
revoke all on table public.auth_otps from anon, authenticated;
grant all on table public.api_users to service_role;
grant all on table public.auth_otps to service_role;

create or replace function public.auth_user_json(u public.api_users)
returns json
language sql
immutable
set search_path = ''
as $$
  select json_build_object(
    'id', u.id, 'email', u.email, 'name', u.name, 'avatar', u.avatar, 'provider', u.provider,
    'username', coalesce(u.username, ''), 'photo', u.photo,
    'api_key', u.api_key, 'banned', u.banned, 'created_at', u.created_at, 'last_login_at', u.last_login_at
  );
$$;

-- Masuk atau daftar: membuat akun dengan p_key bila email belum dikenal.
create or replace function public.auth_login(p_email text, p_name text, p_avatar text, p_provider text, p_key text)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
begin
  insert into public.api_users (email, name, avatar, provider, api_key)
  values (p_email, coalesce(p_name, ''), coalesce(p_avatar, ''), p_provider, p_key)
  on conflict (email) do update set
    last_login_at = clock_timestamp(),
    name = case when public.api_users.name = '' then excluded.name else public.api_users.name end,
    avatar = case when excluded.avatar <> '' then excluded.avatar else public.api_users.avatar end
  returning * into u;
  return public.auth_user_json(u);
end;
$$;

create or replace function public.auth_user(p_id uuid)
returns json
language sql
stable
set search_path = ''
as $$
  select public.auth_user_json(u) from public.api_users u where u.id = p_id;
$$;

-- Dipanggil untuk memeriksa API key pada setiap permintaan (hasilnya di-cache di server).
create or replace function public.auth_key_user(p_key text)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object('id', u.id, 'banned', u.banned) from public.api_users u where u.api_key = p_key;
$$;

create or replace function public.auth_rotate_key(p_id uuid, p_key text)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
begin
  update public.api_users set api_key = p_key, key_rotated_at = now() where id = p_id returning * into u;
  if not found then
    return null;
  end if;
  return public.auth_user_json(u);
end;
$$;

-- Catat kode OTP baru. status: 'sent', 'cooldown' (baru saja dikirim), 'limit' (kuota email/IP per jam habis),
-- atau 'busy' (kuota seluruh situs per jam habis). 'wait' = detik sampai boleh mencoba lagi.
create or replace function public.auth_otp_issue(
  p_email text, p_hash text, p_ip text, p_ttl integer, p_cooldown integer,
  p_max_email integer, p_max_ip integer, p_max_site integer
)
returns json
language plpgsql
set search_path = ''
as $$
declare
  r public.auth_otps;
  fresh boolean;
  wait integer;
  n integer;
begin
  if random() < 0.02 then
    delete from public.auth_otps where last_sent_at < now() - interval '2 days';
  end if;

  select coalesce(sum(window_sends), 0) into n from public.auth_otps where last_sent_at > now() - interval '1 hour';
  if n >= p_max_site then
    return json_build_object('status', 'busy', 'wait', 600);
  end if;
  if p_ip <> '' then
    select coalesce(sum(window_sends), 0) into n from public.auth_otps where ip = p_ip and last_sent_at > now() - interval '1 hour';
    if n >= p_max_ip then
      return json_build_object('status', 'limit', 'wait', 1800);
    end if;
  end if;

  select * into r from public.auth_otps where email = p_email for update;
  if found then
    wait := p_cooldown - floor(extract(epoch from (now() - r.last_sent_at)))::integer;
    if wait > 0 then
      return json_build_object('status', 'cooldown', 'wait', wait);
    end if;
    fresh := r.window_start <= now() - interval '1 hour';
    if not fresh and r.window_sends >= p_max_email then
      return json_build_object('status', 'limit', 'wait', ceil(extract(epoch from (r.window_start + interval '1 hour' - now())))::integer);
    end if;
    update public.auth_otps set
      code_hash = p_hash,
      expires_at = now() + make_interval(secs => p_ttl),
      attempts = 0,
      last_sent_at = now(),
      ip = p_ip,
      window_start = case when fresh then now() else r.window_start end,
      window_sends = case when fresh then 1 else r.window_sends + 1 end
    where email = p_email;
  else
    insert into public.auth_otps (email, code_hash, expires_at, ip)
    values (p_email, p_hash, now() + make_interval(secs => p_ttl), p_ip)
    on conflict (email) do nothing;
    if not found then
      return json_build_object('status', 'cooldown', 'wait', p_cooldown);
    end if;
  end if;
  return json_build_object('status', 'sent', 'wait', p_cooldown);
end;
$$;

-- Periksa kode: 'ok', 'invalid', 'expired', 'locked' (terlalu banyak salah), atau 'none' (tidak ada kode aktif).
-- Kode hanya bisa dipakai sekali.
create or replace function public.auth_otp_check(p_email text, p_hash text, p_max_attempts integer)
returns text
language plpgsql
set search_path = ''
as $$
declare
  r public.auth_otps;
begin
  select * into r from public.auth_otps where email = p_email for update;
  if not found or r.code_hash = '' then
    return 'none';
  end if;
  if r.expires_at < now() then
    return 'expired';
  end if;
  if r.attempts >= p_max_attempts then
    return 'locked';
  end if;
  if r.code_hash = p_hash then
    update public.auth_otps set code_hash = '', attempts = 0 where email = p_email;
    return 'ok';
  end if;
  update public.auth_otps set attempts = attempts + 1 where email = p_email;
  return case when r.attempts + 1 >= p_max_attempts then 'locked' else 'invalid' end;
end;
$$;

-- Email gagal terkirim: batalkan kodenya supaya pengguna bisa langsung mencoba lagi.
create or replace function public.auth_otp_cancel(p_email text)
returns void
language sql
set search_path = ''
as $$
  update public.auth_otps
  set code_hash = '', last_sent_at = now() - interval '1 day', window_sends = greatest(window_sends - 1, 0)
  where email = p_email;
$$;

-- Untuk owner (/api/admin/users): akun terbaru, API key disamarkan.
create or replace function public.auth_admin_users(p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'total', (select count(*) from public.api_users),
    'users', (
      select coalesce(json_agg(t), '[]'::json) from (
        select email, coalesce(username, '') as username, name, provider, banned, created_at, last_login_at,
               left(api_key, 7) || '…' || right(api_key, 4) as api_key
        from public.api_users order by created_at desc limit greatest(1, least(p_limit, 500))
      ) t
    )
  );
$$;

-- true bila username sudah dipakai akun lain.
create or replace function public.auth_username_taken(p_username text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.api_users where username = p_username);
$$;

-- Isi atau ganti username. status: 'ok' (beserta akun), 'taken', 'invalid', atau 'none' (akun tidak ada).
create or replace function public.auth_set_username(p_id uuid, p_username text)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
begin
  update public.api_users set username = p_username where id = p_id returning * into u;
  if not found then
    return json_build_object('status', 'none');
  end if;
  return json_build_object('status', 'ok', 'user', public.auth_user_json(u));
exception
  when unique_violation then
    return json_build_object('status', 'taken');
  when check_violation then
    return json_build_object('status', 'invalid');
end;
$$;

-- Atur foto profil (p_photo kosong = hapus). Mengembalikan nama berkas lama supaya bisa dihapus dari penyimpanan.
create or replace function public.auth_set_photo(p_id uuid, p_photo text)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
  old text;
begin
  select photo into old from public.api_users where id = p_id for update;
  if not found then
    return null;
  end if;
  update public.api_users set photo = p_photo where id = p_id returning * into u;
  return json_build_object('old', old, 'user', public.auth_user_json(u));
end;
$$;

-- Nonaktifkan / aktifkan lagi sebuah akun (API key-nya ikut berhenti / jalan lagi).
create or replace function public.auth_set_banned(p_email text, p_banned boolean)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.api_users set banned = p_banned where email = lower(p_email);
  return found;
end;
$$;

revoke all on function public.auth_user_json(public.api_users) from public, anon, authenticated;
revoke all on function public.auth_login(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.auth_user(uuid) from public, anon, authenticated;
revoke all on function public.auth_key_user(text) from public, anon, authenticated;
revoke all on function public.auth_rotate_key(uuid, text) from public, anon, authenticated;
revoke all on function public.auth_otp_issue(text, text, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.auth_otp_check(text, text, integer) from public, anon, authenticated;
revoke all on function public.auth_otp_cancel(text) from public, anon, authenticated;
revoke all on function public.auth_admin_users(integer) from public, anon, authenticated;
revoke all on function public.auth_set_banned(text, boolean) from public, anon, authenticated;
revoke all on function public.auth_username_taken(text) from public, anon, authenticated;
revoke all on function public.auth_set_username(uuid, text) from public, anon, authenticated;
revoke all on function public.auth_set_photo(uuid, text) from public, anon, authenticated;
grant execute on function public.auth_user_json(public.api_users) to service_role;
grant execute on function public.auth_login(text, text, text, text, text) to service_role;
grant execute on function public.auth_user(uuid) to service_role;
grant execute on function public.auth_key_user(text) to service_role;
grant execute on function public.auth_rotate_key(uuid, text) to service_role;
grant execute on function public.auth_otp_issue(text, text, text, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.auth_otp_check(text, text, integer) to service_role;
grant execute on function public.auth_otp_cancel(text) to service_role;
grant execute on function public.auth_admin_users(integer) to service_role;
grant execute on function public.auth_set_banned(text, boolean) to service_role;
grant execute on function public.auth_username_taken(text) to service_role;
grant execute on function public.auth_set_username(uuid, text) to service_role;
grant execute on function public.auth_set_photo(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Statistik pemakaian per akun (halaman /dashboard).
-- Dicatat per akun, bukan per API key, supaya angkanya tetap ada setelah key diganti.
-- Satu hari dihitung menurut WIB (Asia/Jakarta).
-- ---------------------------------------------------------------------------

create table if not exists public.api_usage (
  user_id uuid not null references public.api_users(id) on delete cascade,
  day date not null,
  path varchar(120) not null,
  hits integer not null default 0,
  errors integer not null default 0,
  primary key (user_id, day, path)
);

create index if not exists api_usage_day_idx on public.api_usage (day);

-- Jumlah sepanjang waktu; tetap utuh setelah baris harian yang lama dihapus.
create table if not exists public.api_usage_totals (
  user_id uuid primary key references public.api_users(id) on delete cascade,
  hits bigint not null default 0,
  errors bigint not null default 0,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);

alter table public.api_usage enable row level security;
alter table public.api_usage_totals enable row level security;
revoke all on table public.api_usage from anon, authenticated;
revoke all on table public.api_usage_totals from anon, authenticated;
grant all on table public.api_usage to service_role;
grant all on table public.api_usage_totals to service_role;

-- Catat satu permintaan milik akun p_id. p_ok = false bila permintaannya berakhir dengan galat.
create or replace function public.auth_usage_hit(p_id uuid, p_path text, p_ok boolean)
returns void
language plpgsql
set search_path = ''
as $$
declare
  today date := (now() at time zone 'Asia/Jakarta')::date;
  bad integer := case when p_ok then 0 else 1 end;
begin
  insert into public.api_usage (user_id, day, path, hits, errors)
  values (p_id, today, left(p_path, 120), 1, bad)
  on conflict (user_id, day, path) do update
    set hits = public.api_usage.hits + 1, errors = public.api_usage.errors + bad;

  insert into public.api_usage_totals (user_id, hits, errors)
  values (p_id, 1, bad)
  on conflict (user_id) do update
    set hits = public.api_usage_totals.hits + 1, errors = public.api_usage_totals.errors + bad, last_at = now();

  -- Sesekali buang baris harian yang lebih tua dari 90 hari supaya tabel tidak terus membesar.
  if random() < 0.002 then
    delete from public.api_usage where day < today - 90;
  end if;
exception
  when foreign_key_violation then
    null; -- akunnya sudah dihapus
end;
$$;

-- Ringkasan untuk dashboard: angka hari ini, 7 dan 30 hari terakhir, total, deret harian
-- p_days hari terakhir (hari tanpa permintaan ikut muncul dengan angka 0), dan endpoint terbanyak.
create or replace function public.auth_usage_summary(p_id uuid, p_days integer)
returns json
language sql
stable
set search_path = ''
as $$
  with t as (select (now() at time zone 'Asia/Jakarta')::date as today),
  u as (select a.day, a.path, a.hits, a.errors from public.api_usage a, t where a.user_id = p_id and a.day > t.today - 30)
  select json_build_object(
    'today', (select coalesce(sum(u.hits), 0) from u, t where u.day = t.today),
    'today_errors', (select coalesce(sum(u.errors), 0) from u, t where u.day = t.today),
    'week', (select coalesce(sum(u.hits), 0) from u, t where u.day > t.today - 7),
    'week_errors', (select coalesce(sum(u.errors), 0) from u, t where u.day > t.today - 7),
    'month', (select coalesce(sum(u.hits), 0) from u),
    'month_errors', (select coalesce(sum(u.errors), 0) from u),
    'total', coalesce((select x.hits from public.api_usage_totals x where x.user_id = p_id), 0),
    'total_errors', coalesce((select x.errors from public.api_usage_totals x where x.user_id = p_id), 0),
    'first_at', (select x.first_at from public.api_usage_totals x where x.user_id = p_id),
    'last_at', (select x.last_at from public.api_usage_totals x where x.user_id = p_id),
    'endpoints', (select count(distinct u.path) from u),
    'days', (
      select coalesce(json_agg(json_build_object('day', d.day, 'hits', d.hits, 'errors', d.errors) order by d.day), '[]'::json)
      from (
        select g.day::date as day, coalesce(sum(u.hits), 0) as hits, coalesce(sum(u.errors), 0) as errors
        from t
        cross join lateral generate_series(t.today - (greatest(1, least(p_days, 30)) - 1), t.today, interval '1 day') as g(day)
        left join u on u.day = g.day::date
        group by g.day
      ) d
    ),
    'top', (
      select coalesce(json_agg(json_build_object('path', p.path, 'hits', p.hits, 'errors', p.errors) order by p.hits desc, p.path), '[]'::json)
      from (select u.path, sum(u.hits) as hits, sum(u.errors) as errors from u group by u.path order by sum(u.hits) desc, u.path limit 8) p
    )
  );
$$;

revoke all on function public.auth_usage_hit(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.auth_usage_summary(uuid, integer) from public, anon, authenticated;
grant execute on function public.auth_usage_hit(uuid, text, boolean) to service_role;
grant execute on function public.auth_usage_summary(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Paket: paket per akun, kuota harian per akun, dan pesanan pembayaran QRIS.
-- Daftar paket (nama, harga, kuota) ada di src/lib/plans.ts; database hanya menyimpan
-- id paket, masa aktifnya, dan riwayat pesanan.
-- ---------------------------------------------------------------------------

-- 'free' atau id paket berbayar. Paket berbayar hanya berlaku selama plan_expires_at belum lewat.
alter table public.api_users add column if not exists plan text not null default 'free';
alter table public.api_users add column if not exists plan_expires_at timestamptz;

-- Satu baris per pesanan. id dipakai sebagai merchant_ref di payment gateway.
-- status: pending | paid | expired | canceled | failed
create table if not exists public.api_orders (
  id text primary key,
  user_id uuid references public.api_users(id) on delete set null,
  plan text not null,
  months integer not null,
  days integer not null,
  amount integer not null,
  total integer,
  fee integer,
  status text not null default 'pending',
  gateway_ref text not null default '',
  payment_url text not null default '',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists api_orders_user_idx on public.api_orders (user_id, created_at desc);

alter table public.api_orders enable row level security;
revoke all on table public.api_orders from anon, authenticated;
grant all on table public.api_orders to service_role;

create or replace function public.auth_user_json(u public.api_users)
returns json
language sql
immutable
set search_path = ''
as $$
  select json_build_object(
    'id', u.id, 'email', u.email, 'name', u.name, 'avatar', u.avatar, 'provider', u.provider,
    'username', coalesce(u.username, ''), 'photo', u.photo,
    'api_key', u.api_key, 'banned', u.banned, 'created_at', u.created_at, 'last_login_at', u.last_login_at,
    'plan', u.plan, 'plan_expires_at', u.plan_expires_at
  );
$$;

-- Dipanggil untuk memeriksa API key pada setiap permintaan (hasilnya di-cache di server).
-- Ikut membawa paket yang sedang berlaku dan pemakaian hari ini (WIB) untuk kuota harian.
create or replace function public.auth_key_user(p_key text)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'id', u.id, 'banned', u.banned,
    'plan', case when u.plan <> 'free' and u.plan_expires_at > now() then u.plan else 'free' end,
    'plan_expires_at', u.plan_expires_at,
    'used_today', coalesce((
      select sum(a.hits) from public.api_usage a
      where a.user_id = u.id and a.day = (now() at time zone 'Asia/Jakarta')::date
    ), 0)
  )
  from public.api_users u where u.api_key = p_key;
$$;

-- Buka pesanan baru, atau pakai lagi pesanan serupa yang masih menunggu (klik ganda tidak
-- membuat tagihan kedua). status: 'ok' (beserta order dan reused) atau 'limit' (terlalu
-- banyak pesanan dalam satu jam).
create or replace function public.plan_order_open(p_id text, p_user uuid, p_plan text, p_months integer, p_days integer, p_amount integer)
returns json
language plpgsql
set search_path = ''
as $$
declare
  o public.api_orders;
begin
  select * into o from public.api_orders
  where user_id = p_user and status = 'pending' and plan = p_plan and months = p_months and amount = p_amount
    and ((expires_at is null and created_at > now() - interval '5 minutes') or expires_at > now() + interval '2 minutes')
  order by created_at desc limit 1;
  if found then
    return json_build_object('status', 'ok', 'reused', true, 'order', row_to_json(o));
  end if;
  if (select count(*) from public.api_orders where user_id = p_user and created_at > now() - interval '1 hour') >= 10 then
    return json_build_object('status', 'limit');
  end if;
  insert into public.api_orders (id, user_id, plan, months, days, amount)
  values (p_id, p_user, p_plan, p_months, p_days, p_amount)
  returning * into o;
  return json_build_object('status', 'ok', 'reused', false, 'order', row_to_json(o));
end;
$$;

-- Simpan data tagihan dari payment gateway ke pesanan yang masih menunggu.
create or replace function public.plan_order_attach(p_id text, p_ref text, p_url text, p_total integer, p_fee integer, p_expires timestamptz)
returns json
language plpgsql
set search_path = ''
as $$
declare
  o public.api_orders;
begin
  update public.api_orders
  set gateway_ref = p_ref, payment_url = p_url, total = p_total, fee = p_fee, expires_at = p_expires
  where id = p_id and status = 'pending'
  returning * into o;
  if not found then
    return null;
  end if;
  return row_to_json(o);
end;
$$;

create or replace function public.plan_order_get(p_id text)
returns json
language sql
stable
set search_path = ''
as $$
  select row_to_json(o) from public.api_orders o where o.id = p_id;
$$;

-- Tandai pesanan lunas dan aktifkan paketnya, dalam satu transaksi dan hanya sekali.
-- status: 'paid' (baru saja diaktifkan), 'already' (sudah lunas sebelumnya), 'none' (pesanan
-- tidak dikenal), atau 'mismatch' (nominal dari gateway tidak sama dengan pesanan).
-- Membeli paket yang sama selagi masih aktif menambah masa aktifnya.
create or replace function public.plan_order_paid(p_id text, p_ref text, p_amount integer)
returns json
language plpgsql
set search_path = ''
as $$
declare
  o public.api_orders;
  u public.api_users;
  base timestamptz;
  v_until timestamptz;
begin
  select * into o from public.api_orders where id = p_id for update;
  if not found then
    return json_build_object('status', 'none');
  end if;
  if o.status = 'paid' then
    return json_build_object('status', 'already', 'order', row_to_json(o));
  end if;
  if p_amount is distinct from o.amount then
    return json_build_object('status', 'mismatch');
  end if;

  select * into u from public.api_users where id = o.user_id for update;
  if found then
    base := case when u.plan = o.plan and u.plan_expires_at > now() then u.plan_expires_at else now() end;
    v_until := base + make_interval(days => o.days);
    update public.api_users set plan = o.plan, plan_expires_at = v_until where id = u.id;
  end if;

  update public.api_orders
  set status = 'paid', paid_at = now(), gateway_ref = case when coalesce(p_ref, '') <> '' then p_ref else gateway_ref end
  where id = p_id
  returning * into o;
  return json_build_object('status', 'paid', 'order', row_to_json(o), 'plan', o.plan, 'plan_expires_at', v_until);
end;
$$;

-- Tutup pesanan yang belum lunas (kedaluwarsa, dibatalkan, atau gagal dibuat di gateway).
create or replace function public.plan_order_close(p_id text, p_status text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_status not in ('expired', 'canceled', 'failed') then
    return false;
  end if;
  update public.api_orders set status = p_status where id = p_id and status = 'pending';
  return found;
end;
$$;

-- Riwayat pesanan sebuah akun, terbaru dulu.
create or replace function public.plan_orders(p_user uuid, p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select o.* from public.api_orders o where o.user_id = p_user
    order by o.created_at desc limit greatest(1, least(p_limit, 50))
  ) t;
$$;

-- Untuk owner (/api/admin/setplan): atur paket sebuah akun tanpa pembayaran.
-- p_plan = 'free' atau p_days <= 0 mengembalikan akun ke paket gratis.
create or replace function public.plan_admin_set(p_email text, p_plan text, p_days integer)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
begin
  select * into u from public.api_users where email = lower(p_email) for update;
  if not found then
    return null;
  end if;
  if p_plan = 'free' or p_days <= 0 then
    update public.api_users set plan = 'free', plan_expires_at = null where id = u.id returning * into u;
  else
    update public.api_users set
      plan = p_plan,
      plan_expires_at = (case when u.plan = p_plan and u.plan_expires_at > now() then u.plan_expires_at else now() end) + make_interval(days => p_days)
    where id = u.id returning * into u;
  end if;
  return json_build_object('email', u.email, 'username', coalesce(u.username, ''), 'plan', u.plan, 'plan_expires_at', u.plan_expires_at);
end;
$$;

-- Untuk owner (/api/admin/orders): pesanan terbaru beserta email pembelinya.
create or replace function public.plan_admin_orders(p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'paid', (select count(*) from public.api_orders where status = 'paid'),
    'paid_amount', (select coalesce(sum(amount), 0) from public.api_orders where status = 'paid'),
    'orders', (
      select coalesce(json_agg(t), '[]'::json) from (
        select o.id, coalesce(u.email, '') as email, coalesce(u.username, '') as username, o.plan, o.months, o.amount, o.total,
               o.status, o.gateway_ref, o.created_at, o.paid_at
        from public.api_orders o left join public.api_users u on u.id = o.user_id
        order by o.created_at desc limit greatest(1, least(p_limit, 500))
      ) t
    )
  );
$$;

-- Untuk owner (/api/admin/users): akun terbaru, API key disamarkan, beserta paketnya.
create or replace function public.auth_admin_users(p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'total', (select count(*) from public.api_users),
    'users', (
      select coalesce(json_agg(t), '[]'::json) from (
        select email, coalesce(username, '') as username, name, provider, banned, created_at, last_login_at,
               left(api_key, 7) || '…' || right(api_key, 4) as api_key,
               case when plan <> 'free' and plan_expires_at > now() then plan else 'free' end as plan, plan_expires_at
        from public.api_users order by created_at desc limit greatest(1, least(p_limit, 500))
      ) t
    )
  );
$$;

revoke all on function public.plan_order_open(text, uuid, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.plan_order_attach(text, text, text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.plan_order_get(text) from public, anon, authenticated;
revoke all on function public.plan_order_paid(text, text, integer) from public, anon, authenticated;
revoke all on function public.plan_order_close(text, text) from public, anon, authenticated;
revoke all on function public.plan_orders(uuid, integer) from public, anon, authenticated;
revoke all on function public.plan_admin_set(text, text, integer) from public, anon, authenticated;
revoke all on function public.plan_admin_orders(integer) from public, anon, authenticated;
grant execute on function public.plan_order_open(text, uuid, text, integer, integer, integer) to service_role;
grant execute on function public.plan_order_attach(text, text, text, integer, integer, timestamptz) to service_role;
grant execute on function public.plan_order_get(text) to service_role;
grant execute on function public.plan_order_paid(text, text, integer) to service_role;
grant execute on function public.plan_order_close(text, text) to service_role;
grant execute on function public.plan_orders(uuid, integer) to service_role;
grant execute on function public.plan_admin_set(text, text, integer) to service_role;
grant execute on function public.plan_admin_orders(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Akun admin (halaman /admin).
-- Akun admin boleh menjalankan aksi /api/admin dengan sesi loginnya (tanpa ADMIN_KEY) dan
-- tidak terkena kuota harian. Status admin hanya diubah lewat auth_set_admin.
-- Fungsi auth_user_json, auth_key_user, auth_set_banned, dan auth_admin_users di bawah ini
-- menggantikan versi di atas.
-- ---------------------------------------------------------------------------

alter table public.api_users add column if not exists is_admin boolean not null default false;

create or replace function public.auth_user_json(u public.api_users)
returns json
language sql
immutable
set search_path = ''
as $$
  select json_build_object(
    'id', u.id, 'email', u.email, 'name', u.name, 'avatar', u.avatar, 'provider', u.provider,
    'username', coalesce(u.username, ''), 'photo', u.photo,
    'api_key', u.api_key, 'banned', u.banned, 'created_at', u.created_at, 'last_login_at', u.last_login_at,
    'plan', u.plan, 'plan_expires_at', u.plan_expires_at, 'is_admin', u.is_admin
  );
$$;

create or replace function public.auth_key_user(p_key text)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'id', u.id, 'banned', u.banned, 'is_admin', u.is_admin,
    'plan', case when u.plan <> 'free' and u.plan_expires_at > now() then u.plan else 'free' end,
    'plan_expires_at', u.plan_expires_at,
    'used_today', coalesce((
      select sum(a.hits) from public.api_usage a
      where a.user_id = u.id and a.day = (now() at time zone 'Asia/Jakarta')::date
    ), 0)
  )
  from public.api_users u where u.api_key = p_key;
$$;

-- Akun admin tidak bisa dinonaktifkan; cabut dulu status adminnya (auth_set_admin).
create or replace function public.auth_set_banned(p_email text, p_banned boolean)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.api_users set banned = p_banned where email = lower(p_email) and not (p_banned and is_admin);
  return found;
end;
$$;

-- Jadikan sebuah akun admin, atau cabut status adminnya (/api/admin/setadmin, hanya dengan ADMIN_KEY).
create or replace function public.auth_set_admin(p_email text, p_admin boolean)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
begin
  update public.api_users set is_admin = p_admin where email = lower(p_email) returning * into u;
  if not found then
    return null;
  end if;
  return json_build_object('email', u.email, 'username', coalesce(u.username, ''), 'is_admin', u.is_admin);
end;
$$;

-- Untuk owner dan admin (/api/admin/users): akun terbaru, API key disamarkan, beserta paket dan pemakaiannya.
create or replace function public.auth_admin_users(p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'total', (select count(*) from public.api_users),
    'users', (
      select coalesce(json_agg(t), '[]'::json) from (
        select u.email, coalesce(u.username, '') as username, u.name, u.provider, u.banned, u.is_admin, u.created_at, u.last_login_at,
               left(u.api_key, 7) || '…' || right(u.api_key, 4) as api_key,
               case when u.plan <> 'free' and u.plan_expires_at > now() then u.plan else 'free' end as plan, u.plan_expires_at,
               coalesce((select sum(a.hits) from public.api_usage a where a.user_id = u.id and a.day = (now() at time zone 'Asia/Jakarta')::date), 0) as used_today,
               coalesce((select x.hits from public.api_usage_totals x where x.user_id = u.id), 0) as used_total
        from public.api_users u order by u.created_at desc limit greatest(1, least(p_limit, 500))
      ) t
    )
  );
$$;

revoke all on function public.auth_set_admin(text, boolean) from public, anon, authenticated;
grant execute on function public.auth_set_admin(text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Blokir API
-- Endpoint yang dinonaktifkan admin. `path` berisi "kategori/slug" (mis. film/lk21), atau
-- "kategori/*" untuk satu kategori penuh. Permintaan ke endpoint itu dijawab 503.
-- Kelola lewat halaman /admin, atau /api/admin/apiblocks, apiblock, apiunblock.
-- Mengaktifkan lagi secara manual: hapus barisnya di sini.
-- ---------------------------------------------------------------------------
create table if not exists public.blocked_endpoints (
  path varchar(120) primary key,
  reason text not null default '',
  created_at timestamptz not null default now()
);

alter table public.blocked_endpoints enable row level security;

-- Hanya server (service role) yang membaca dan mengubah tabel ini.
revoke all on table public.blocked_endpoints from anon, authenticated;
grant select, insert, update, delete on table public.blocked_endpoints to service_role;

-- ---------------------------------------------------------------------------
-- Blokir API pengguna
-- Admin bisa memblokir API sebuah akun untuk sementara (api_blocked_until terisi) atau selamanya
-- (api_blocked_until null). Selama diblokir API key akun itu ditolak (403), tetapi akunnya masih
-- bisa masuk ke situs. Berbeda dengan `banned`, yang menonaktifkan akunnya sekaligus.
-- Kelola lewat halaman /admin, atau /api/admin/keyblocks, keyblock, keyunblock.
-- Fungsi auth_user_json, auth_key_user, dan auth_admin_users di bawah ini menggantikan versi di atas.
-- ---------------------------------------------------------------------------

alter table public.api_users
  add column if not exists api_blocked boolean not null default false,
  add column if not exists api_blocked_until timestamptz,
  add column if not exists api_block_reason text not null default '',
  add column if not exists api_blocked_at timestamptz;

create or replace function public.auth_user_json(u public.api_users)
returns json
language sql
immutable
set search_path = ''
as $$
  select json_build_object(
    'id', u.id, 'email', u.email, 'name', u.name, 'avatar', u.avatar, 'provider', u.provider,
    'username', coalesce(u.username, ''), 'photo', u.photo,
    'api_key', u.api_key, 'banned', u.banned, 'created_at', u.created_at, 'last_login_at', u.last_login_at,
    'plan', u.plan, 'plan_expires_at', u.plan_expires_at, 'is_admin', u.is_admin,
    'api_blocked', u.api_blocked, 'api_blocked_until', u.api_blocked_until, 'api_block_reason', u.api_block_reason
  );
$$;

create or replace function public.auth_key_user(p_key text)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'id', u.id, 'banned', u.banned, 'is_admin', u.is_admin,
    'api_blocked', u.api_blocked, 'api_blocked_until', u.api_blocked_until, 'api_block_reason', u.api_block_reason,
    'plan', case when u.plan <> 'free' and u.plan_expires_at > now() then u.plan else 'free' end,
    'plan_expires_at', u.plan_expires_at,
    'used_today', coalesce((
      select sum(a.hits) from public.api_usage a
      where a.user_id = u.id and a.day = (now() at time zone 'Asia/Jakarta')::date
    ), 0)
  )
  from public.api_users u where u.api_key = p_key;
$$;

-- Blokir atau buka blokir API sebuah akun. p_until null berarti selamanya.
-- Mengembalikan null bila akunnya tidak ada, atau bila yang hendak diblokir adalah akun admin.
create or replace function public.auth_set_api_block(p_email text, p_blocked boolean, p_until timestamptz, p_reason text)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
begin
  update public.api_users set
    api_blocked = p_blocked,
    api_blocked_until = case when p_blocked then p_until else null end,
    api_block_reason = case when p_blocked then left(coalesce(p_reason, ''), 300) else '' end,
    api_blocked_at = case when p_blocked then now() else null end
  where email = lower(p_email) and not (p_blocked and is_admin)
  returning * into u;
  if not found then
    return null;
  end if;
  return json_build_object(
    'email', u.email, 'username', coalesce(u.username, ''),
    'api_blocked', u.api_blocked, 'api_blocked_until', u.api_blocked_until, 'api_block_reason', u.api_block_reason
  );
end;
$$;

-- Untuk owner dan admin (/api/admin/keyblocks): akun yang API-nya sedang diblokir.
-- Blokir sementara yang sudah lewat waktunya tidak ikut.
create or replace function public.auth_api_blocked(p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select coalesce(json_agg(t), '[]'::json) from (
    select u.email, coalesce(u.username, '') as username, u.api_blocked_until, u.api_block_reason, u.api_blocked_at
    from public.api_users u
    where u.api_blocked and (u.api_blocked_until is null or u.api_blocked_until > now())
    order by u.api_blocked_at desc nulls last
    limit greatest(1, least(p_limit, 500))
  ) t;
$$;

-- Untuk owner dan admin (/api/admin/users): akun terbaru, API key disamarkan, beserta paket, pemakaian, dan blokir API-nya.
create or replace function public.auth_admin_users(p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'total', (select count(*) from public.api_users),
    'users', (
      select coalesce(json_agg(t), '[]'::json) from (
        select u.email, coalesce(u.username, '') as username, u.name, u.provider, u.banned, u.is_admin, u.created_at, u.last_login_at,
               left(u.api_key, 7) || '…' || right(u.api_key, 4) as api_key,
               case when u.plan <> 'free' and u.plan_expires_at > now() then u.plan else 'free' end as plan, u.plan_expires_at,
               coalesce((select sum(a.hits) from public.api_usage a where a.user_id = u.id and a.day = (now() at time zone 'Asia/Jakarta')::date), 0) as used_today,
               coalesce((select x.hits from public.api_usage_totals x where x.user_id = u.id), 0) as used_total,
               (u.api_blocked and (u.api_blocked_until is null or u.api_blocked_until > now())) as api_blocked,
               u.api_blocked_until, u.api_block_reason
        from public.api_users u order by u.created_at desc limit greatest(1, least(p_limit, 500))
      ) t
    )
  );
$$;

revoke all on function public.auth_set_api_block(text, boolean, timestamptz, text) from public, anon, authenticated;
grant execute on function public.auth_set_api_block(text, boolean, timestamptz, text) to service_role;
revoke all on function public.auth_api_blocked(integer) from public, anon, authenticated;
grant execute on function public.auth_api_blocked(integer) to service_role;
