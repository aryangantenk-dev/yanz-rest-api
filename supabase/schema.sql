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

-- ---------------------------------------------------------------------------
-- Riwayat penggunaan API
-- 200 permintaan terakhir tiap akun: waktu, endpoint, kode status, dan lama proses.
-- Tampil di /dashboard (milik akun itu sendiri) dan di /admin (tombol "Riwayat API" di kartu akun,
-- atau /api/admin/userusage). Hitungan harian tetap di api_usage; tabel ini hanya rincian terbaru.
-- ---------------------------------------------------------------------------

create table if not exists public.api_usage_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.api_users(id) on delete cascade,
  at timestamptz not null default now(),
  path varchar(120) not null,
  status smallint not null default 200,
  ms integer not null default 0
);

create index if not exists api_usage_log_user_idx on public.api_usage_log (user_id, id desc);

alter table public.api_usage_log enable row level security;
revoke all on table public.api_usage_log from anon, authenticated;
grant all on table public.api_usage_log to service_role;

-- Catat satu permintaan milik akun p_id: naikkan hitungan hariannya (auth_usage_hit) dan
-- tambahkan satu baris riwayat berisi kode status dan lama prosesnya (milidetik).
create or replace function public.auth_usage_record(p_id uuid, p_path text, p_ok boolean, p_status integer, p_ms integer)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform public.auth_usage_hit(p_id, p_path, p_ok);
  begin
    insert into public.api_usage_log (user_id, path, status, ms)
    values (p_id, left(p_path, 120), greatest(100, least(coalesce(p_status, 200), 599)), greatest(0, least(coalesce(p_ms, 0), 3600000)));

    -- Sesekali buang baris di luar 200 permintaan terakhir akun ini supaya tabel tidak terus membesar.
    if random() < 0.05 then
      delete from public.api_usage_log l
      where l.user_id = p_id
        and l.id < (select k.id from public.api_usage_log k where k.user_id = p_id order by k.id desc offset 199 limit 1);
    end if;
  exception
    when foreign_key_violation then
      null; -- akunnya sudah dihapus
  end;
end;
$$;

-- Permintaan terakhir milik akun p_id, dari yang paling baru (paling banyak 200).
create or replace function public.auth_usage_history(p_id uuid, p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select coalesce(json_agg(json_build_object('at', t.at, 'path', t.path, 'status', t.status, 'ms', t.ms) order by t.id desc), '[]'::json)
  from (
    select l.id, l.at, l.path, l.status, l.ms
    from public.api_usage_log l
    where l.user_id = p_id
    order by l.id desc
    limit greatest(1, least(p_limit, 200))
  ) t;
$$;

-- Untuk owner dan admin (/api/admin/userusage): ringkasan dan riwayat pemakaian satu akun.
-- Mengembalikan null bila akunnya tidak ada.
create or replace function public.auth_admin_usage(p_email text, p_days integer, p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select json_build_object(
    'user', json_build_object(
      'email', u.email, 'username', coalesce(u.username, ''), 'is_admin', u.is_admin, 'created_at', u.created_at,
      'plan', case when u.plan <> 'free' and u.plan_expires_at > now() then u.plan else 'free' end
    ),
    'usage', public.auth_usage_summary(u.id, p_days),
    'history', public.auth_usage_history(u.id, p_limit)
  )
  from public.api_users u where u.email = lower(p_email);
$$;

revoke all on function public.auth_usage_record(uuid, text, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.auth_usage_history(uuid, integer) from public, anon, authenticated;
revoke all on function public.auth_admin_usage(text, integer, integer) from public, anon, authenticated;
grant execute on function public.auth_usage_record(uuid, text, boolean, integer, integer) to service_role;
grant execute on function public.auth_usage_history(uuid, integer) to service_role;
grant execute on function public.auth_admin_usage(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Paket harian dan limit tambahan.
-- Paket sekarang dihargai per hari dan pembeli memilih jumlah harinya (api_orders.days).
-- Limit tambahan adalah saldo permintaan per akun (api_users.extra_limit) yang dibeli
-- terpisah: pesanannya memakai plan = 'limit' dan qty = jumlah limit. Saldo itu dipotong
-- satu per permintaan setelah kuota harian paket habis, dan tidak pernah hangus.
-- ---------------------------------------------------------------------------

alter table public.api_users add column if not exists extra_limit integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_users_extra_limit_check') then
    alter table public.api_users add constraint api_users_extra_limit_check check (extra_limit >= 0);
  end if;
end;
$$;

-- qty: jumlah limit yang dibeli (0 untuk pesanan paket). months hanya terisi pada pesanan lama.
alter table public.api_orders add column if not exists qty integer not null default 0;
alter table public.api_orders alter column months set default 0;

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
    'api_blocked', u.api_blocked, 'api_blocked_until', u.api_blocked_until, 'api_block_reason', u.api_block_reason,
    'extra_limit', u.extra_limit
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
    'extra_limit', u.extra_limit,
    'used_today', coalesce((
      select sum(a.hits) from public.api_usage a
      where a.user_id = u.id and a.day = (now() at time zone 'Asia/Jakarta')::date
    ), 0)
  )
  from public.api_users u where u.api_key = p_key;
$$;

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
               u.api_blocked_until, u.api_block_reason, u.extra_limit
        from public.api_users u order by u.created_at desc limit greatest(1, least(p_limit, 500))
      ) t
    )
  );
$$;

-- Catat satu permintaan. p_extra: permintaan ini memakai limit tambahan (kuota harian sudah
-- habis), jadi saldonya dipotong satu dan tidak pernah turun di bawah nol.
drop function if exists public.auth_usage_record(uuid, text, boolean, integer, integer);
create or replace function public.auth_usage_record(p_id uuid, p_path text, p_ok boolean, p_status integer, p_ms integer, p_extra boolean default false)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform public.auth_usage_hit(p_id, p_path, p_ok);
  if p_extra then
    update public.api_users set extra_limit = extra_limit - 1 where id = p_id and extra_limit > 0;
  end if;
  begin
    insert into public.api_usage_log (user_id, path, status, ms)
    values (p_id, left(p_path, 120), greatest(100, least(coalesce(p_status, 200), 599)), greatest(0, least(coalesce(p_ms, 0), 3600000)));

    -- Sesekali buang baris di luar 200 permintaan terakhir akun ini supaya tabel tidak terus membesar.
    if random() < 0.05 then
      delete from public.api_usage_log l
      where l.user_id = p_id
        and l.id < (select k.id from public.api_usage_log k where k.user_id = p_id order by k.id desc offset 199 limit 1);
    end if;
  exception
    when foreign_key_violation then
      null; -- akunnya sudah dihapus
  end;
end;
$$;

revoke all on function public.auth_usage_record(uuid, text, boolean, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.auth_usage_record(uuid, text, boolean, integer, integer, boolean) to service_role;

-- Buka pesanan baru, atau pakai lagi pesanan serupa yang masih menunggu. p_qty > 0 hanya
-- untuk pesanan limit tambahan (p_plan = 'limit'); pesanan paket memakai p_days.
drop function if exists public.plan_order_open(text, uuid, text, integer, integer, integer);
create or replace function public.plan_order_open(p_id text, p_user uuid, p_plan text, p_months integer, p_days integer, p_amount integer, p_qty integer default 0)
returns json
language plpgsql
set search_path = ''
as $$
declare
  o public.api_orders;
begin
  select * into o from public.api_orders
  where user_id = p_user and status = 'pending' and plan = p_plan and days = p_days and qty = p_qty and amount = p_amount
    and ((expires_at is null and created_at > now() - interval '5 minutes') or expires_at > now() + interval '2 minutes')
  order by created_at desc limit 1;
  if found then
    return json_build_object('status', 'ok', 'reused', true, 'order', row_to_json(o));
  end if;
  if (select count(*) from public.api_orders where user_id = p_user and created_at > now() - interval '1 hour') >= 10 then
    return json_build_object('status', 'limit');
  end if;
  insert into public.api_orders (id, user_id, plan, months, days, qty, amount)
  values (p_id, p_user, p_plan, coalesce(p_months, 0), p_days, coalesce(p_qty, 0), p_amount)
  returning * into o;
  return json_build_object('status', 'ok', 'reused', false, 'order', row_to_json(o));
end;
$$;

revoke all on function public.plan_order_open(text, uuid, text, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.plan_order_open(text, uuid, text, integer, integer, integer, integer) to service_role;

-- Tandai pesanan lunas, dalam satu transaksi dan hanya sekali. Pesanan paket mengaktifkan
-- paketnya (paket yang sama menambah masa aktif, paket lain mulai dari sekarang); pesanan
-- limit tambahan menambah saldo extra_limit dan tidak menyentuh paket.
create or replace function public.plan_order_paid(p_id text, p_ref text, p_amount integer)
returns json
language plpgsql
set search_path = ''
as $$
declare
  o public.api_orders;
  u public.api_users;
  base timestamptz;
  v_plan text;
  v_until timestamptz;
  v_extra integer;
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
    if o.plan = 'limit' then
      update public.api_users set extra_limit = extra_limit + greatest(0, o.qty) where id = u.id
      returning plan, plan_expires_at, extra_limit into v_plan, v_until, v_extra;
    else
      base := case when u.plan = o.plan and u.plan_expires_at > now() then u.plan_expires_at else now() end;
      update public.api_users set plan = o.plan, plan_expires_at = base + make_interval(days => o.days) where id = u.id
      returning plan, plan_expires_at, extra_limit into v_plan, v_until, v_extra;
    end if;
  end if;

  update public.api_orders
  set status = 'paid', paid_at = now(), gateway_ref = case when coalesce(p_ref, '') <> '' then p_ref else gateway_ref end
  where id = p_id
  returning * into o;
  return json_build_object('status', 'paid', 'order', row_to_json(o), 'plan', v_plan, 'plan_expires_at', v_until, 'extra_limit', v_extra);
end;
$$;

-- Untuk owner (/api/admin/addlimit): tambah saldo limit tambahan sebuah akun tanpa
-- pembayaran. p_amount negatif mengurangi; saldo tidak pernah turun di bawah nol.
create or replace function public.plan_admin_add_limit(p_email text, p_amount integer)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
begin
  update public.api_users
  set extra_limit = least(2000000000::bigint, greatest(0::bigint, extra_limit::bigint + coalesce(p_amount, 0)))::integer
  where email = lower(p_email)
  returning * into u;
  if not found then
    return null;
  end if;
  return json_build_object('email', u.email, 'username', coalesce(u.username, ''), 'extra_limit', u.extra_limit);
end;
$$;

revoke all on function public.plan_admin_add_limit(text, integer) from public, anon, authenticated;
grant execute on function public.plan_admin_add_limit(text, integer) to service_role;

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
        select o.id, coalesce(u.email, '') as email, coalesce(u.username, '') as username, o.plan, o.months, o.days, o.qty, o.amount, o.total,
               o.status, o.gateway_ref, o.created_at, o.paid_at
        from public.api_orders o left join public.api_users u on u.id = o.user_id
        order by o.created_at desc limit greatest(1, least(p_limit, 500))
      ) t
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Kode hadiah dan referral.
-- Kode hadiah dibuat admin: berisi paket (plan + days), limit tambahan (qty), atau keduanya.
-- max_uses null berarti boleh ditukar tanpa batas; expires_at null berarti tidak kedaluwarsa.
-- Satu akun hanya bisa menukar satu kode sekali (api_code_uses).
-- Referral: tiap akun punya ref_code. Akun baru yang mendaftar lewat tautan referral mencatat
-- pengundangnya di referred_by; setiap pesanan lunas akun itu memberi pengundangnya limit
-- tambahan sebesar persentase dari nominal pesanan (api_referral_rewards, sekali per pesanan).
-- ---------------------------------------------------------------------------

create table if not exists public.api_codes (
  code text primary key,
  plan text not null default '',
  days integer not null default 0,
  qty integer not null default 0,
  max_uses integer,
  used integer not null default 0,
  expires_at timestamptz,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint api_codes_content_check check ((plan <> '' and days > 0) or qty > 0)
);

create table if not exists public.api_code_uses (
  code text not null references public.api_codes(code) on delete cascade,
  user_id uuid not null references public.api_users(id) on delete cascade,
  used_at timestamptz not null default now(),
  primary key (code, user_id)
);

create index if not exists api_code_uses_user_idx on public.api_code_uses (user_id);

alter table public.api_codes enable row level security;
alter table public.api_code_uses enable row level security;
revoke all on table public.api_codes from anon, authenticated;
revoke all on table public.api_code_uses from anon, authenticated;
grant all on table public.api_codes to service_role;
grant all on table public.api_code_uses to service_role;

-- Buat kode baru. status: 'ok' (beserta code) atau 'exists' (kode itu sudah ada).
create or replace function public.code_create(p_code text, p_plan text, p_days integer, p_qty integer, p_max integer, p_expires timestamptz, p_note text)
returns json
language plpgsql
set search_path = ''
as $$
declare
  c public.api_codes;
begin
  insert into public.api_codes (code, plan, days, qty, max_uses, expires_at, note)
  values (upper(p_code), coalesce(p_plan, ''), greatest(0, coalesce(p_days, 0)), greatest(0, coalesce(p_qty, 0)),
          case when p_max is null or p_max <= 0 then null else p_max end, p_expires, left(coalesce(p_note, ''), 120))
  on conflict (code) do nothing
  returning * into c;
  if not found then
    return json_build_object('status', 'exists');
  end if;
  return json_build_object('status', 'ok', 'code', row_to_json(c));
end;
$$;

-- Untuk admin: semua kode, terbaru dulu, beserta lima penukar terakhirnya.
create or replace function public.code_list(p_limit integer)
returns json
language sql
stable
set search_path = ''
as $$
  select coalesce(json_agg(t), '[]'::json) from (
    select c.code, c.plan, c.days, c.qty, c.max_uses, c.used, c.expires_at, c.note, c.created_at,
           (select coalesce(json_agg(x), '[]'::json) from (
              select coalesce(nullif(u.username, ''), u.email) as who, s.used_at
              from public.api_code_uses s join public.api_users u on u.id = s.user_id
              where s.code = c.code order by s.used_at desc limit 5
            ) x) as recent
    from public.api_codes c
    order by c.created_at desc limit greatest(1, least(p_limit, 500))
  ) t;
$$;

create or replace function public.code_delete(p_code text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  delete from public.api_codes where code = upper(p_code);
  return found;
end;
$$;

-- Tukarkan kode untuk sebuah akun, dalam satu transaksi.
-- status: 'ok', 'none' (kode tidak ada), 'expired', 'used_up' (kuota penukaran habis),
-- 'already' (akun ini sudah pernah menukarnya), atau 'conflict' (akun punya paket berbayar lain
-- yang masih aktif dan p_force belum true; tidak ada yang diubah).
-- Paket yang sama menambah masa aktif; paket lain menggantikannya mulai sekarang.
create or replace function public.code_redeem(p_user uuid, p_code text, p_force boolean)
returns json
language plpgsql
set search_path = ''
as $$
declare
  c public.api_codes;
  u public.api_users;
  v_active boolean;
  base timestamptz;
begin
  select * into c from public.api_codes where code = upper(p_code) for update;
  if not found then
    return json_build_object('status', 'none');
  end if;
  if c.expires_at is not null and c.expires_at <= now() then
    return json_build_object('status', 'expired');
  end if;
  if c.max_uses is not null and c.used >= c.max_uses then
    return json_build_object('status', 'used_up');
  end if;
  if exists (select 1 from public.api_code_uses s where s.code = c.code and s.user_id = p_user) then
    return json_build_object('status', 'already');
  end if;

  select * into u from public.api_users where id = p_user for update;
  if not found then
    return json_build_object('status', 'none');
  end if;

  if c.plan <> '' and c.days > 0 then
    v_active := u.plan <> 'free' and u.plan_expires_at > now();
    if v_active and u.plan <> c.plan and not coalesce(p_force, false) then
      return json_build_object('status', 'conflict', 'plan', c.plan, 'days', c.days, 'qty', c.qty, 'current', u.plan, 'current_until', u.plan_expires_at);
    end if;
    base := case when v_active and u.plan = c.plan then u.plan_expires_at else now() end;
    update public.api_users set plan = c.plan, plan_expires_at = base + make_interval(days => c.days) where id = u.id;
  end if;
  if c.qty > 0 then
    update public.api_users set extra_limit = least(2000000000::bigint, extra_limit::bigint + c.qty)::integer where id = u.id;
  end if;

  insert into public.api_code_uses (code, user_id) values (c.code, p_user);
  update public.api_codes set used = used + 1 where code = c.code;

  select * into u from public.api_users where id = p_user;
  return json_build_object('status', 'ok', 'plan', c.plan, 'days', c.days, 'qty', c.qty,
                           'user_plan', u.plan, 'plan_expires_at', u.plan_expires_at, 'extra_limit', u.extra_limit);
end;
$$;

revoke all on function public.code_create(text, text, integer, integer, integer, timestamptz, text) from public, anon, authenticated;
revoke all on function public.code_list(integer) from public, anon, authenticated;
revoke all on function public.code_delete(text) from public, anon, authenticated;
revoke all on function public.code_redeem(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.code_create(text, text, integer, integer, integer, timestamptz, text) to service_role;
grant execute on function public.code_list(integer) to service_role;
grant execute on function public.code_delete(text) to service_role;
grant execute on function public.code_redeem(uuid, text, boolean) to service_role;

-- Referral.
alter table public.api_users add column if not exists ref_code text;
alter table public.api_users add column if not exists referred_by uuid references public.api_users(id) on delete set null;
alter table public.api_users add column if not exists referred_at timestamptz;
alter table public.api_users add column if not exists ref_earned integer not null default 0;

update public.api_users set ref_code = upper(substr(md5(gen_random_uuid()::text), 1, 8)) where ref_code is null;
alter table public.api_users alter column ref_code set default upper(substr(md5(gen_random_uuid()::text), 1, 8));

create unique index if not exists api_users_ref_code_key on public.api_users (ref_code);
create index if not exists api_users_referred_by_idx on public.api_users (referred_by);

-- Satu baris per pesanan lunas yang memberi hadiah; order_id unik supaya hadiah tidak dobel.
create table if not exists public.api_referral_rewards (
  order_id text primary key references public.api_orders(id) on delete cascade,
  referrer uuid not null references public.api_users(id) on delete cascade,
  buyer uuid references public.api_users(id) on delete set null,
  amount integer not null,
  created_at timestamptz not null default now()
);

create index if not exists api_referral_rewards_referrer_idx on public.api_referral_rewards (referrer, created_at desc);

alter table public.api_referral_rewards enable row level security;
revoke all on table public.api_referral_rewards from anon, authenticated;
grant all on table public.api_referral_rewards to service_role;

-- Catat pengundang sebuah akun baru. Hanya sekali, hanya untuk akun yang dibuat kurang dari
-- satu jam lalu (pendaftar baru), tidak boleh diri sendiri, dan tidak boleh saling mengundang.
create or replace function public.ref_attach(p_user uuid, p_code text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.api_users u
  set referred_by = r.id, referred_at = now()
  from public.api_users r
  where u.id = p_user and u.referred_by is null and u.created_at > now() - interval '1 hour'
    and r.ref_code = upper(p_code) and r.id <> u.id and not r.banned
    and r.referred_by is distinct from u.id;
  return found;
end;
$$;

-- Beri hadiah referral untuk satu pesanan lunas: p_percent persen dari nominal pesanan, dalam
-- limit tambahan, untuk pengundang pembelinya. Aman dipanggil berkali-kali.
-- status: 'ok' (beserta amount), 'already', atau 'none' (tidak ada yang perlu diberi).
create or replace function public.ref_reward(p_order text, p_percent integer)
returns json
language plpgsql
set search_path = ''
as $$
declare
  o public.api_orders;
  v_ref uuid;
  v_amount integer;
begin
  select * into o from public.api_orders where id = p_order;
  if not found or o.status <> 'paid' or o.user_id is null then
    return json_build_object('status', 'none');
  end if;
  select u.referred_by into v_ref from public.api_users u where u.id = o.user_id;
  if v_ref is null then
    return json_build_object('status', 'none');
  end if;
  v_amount := floor(o.amount::numeric * greatest(0, least(coalesce(p_percent, 0), 100)) / 100)::integer;
  if v_amount <= 0 then
    return json_build_object('status', 'none');
  end if;

  insert into public.api_referral_rewards (order_id, referrer, buyer, amount)
  values (o.id, v_ref, o.user_id, v_amount)
  on conflict (order_id) do nothing;
  if not found then
    return json_build_object('status', 'already');
  end if;

  update public.api_users
  set extra_limit = least(2000000000::bigint, extra_limit::bigint + v_amount)::integer, ref_earned = ref_earned + v_amount
  where id = v_ref and not banned;
  return json_build_object('status', 'ok', 'amount', v_amount);
end;
$$;

-- Ringkasan referral sebuah akun untuk /dashboard.
create or replace function public.ref_summary(p_user uuid)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
begin
  update public.api_users set ref_code = upper(substr(md5(gen_random_uuid()::text), 1, 8)) where id = p_user and ref_code is null;
  select * into u from public.api_users where id = p_user;
  if not found then
    return null;
  end if;
  return json_build_object(
    'code', u.ref_code,
    'earned', u.ref_earned,
    'invited', (select count(*) from public.api_users x where x.referred_by = u.id),
    'buyers', (select count(distinct w.buyer) from public.api_referral_rewards w where w.referrer = u.id),
    'rewards', (
      select coalesce(json_agg(t), '[]'::json) from (
        select w.created_at as at, w.amount from public.api_referral_rewards w
        where w.referrer = u.id order by w.created_at desc limit 10
      ) t
    )
  );
end;
$$;

revoke all on function public.ref_attach(uuid, text) from public, anon, authenticated;
revoke all on function public.ref_reward(text, integer) from public, anon, authenticated;
revoke all on function public.ref_summary(uuid) from public, anon, authenticated;
grant execute on function public.ref_attach(uuid, text) to service_role;
grant execute on function public.ref_reward(text, integer) to service_role;
grant execute on function public.ref_summary(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Chat global: satu ruang obrolan untuk semua anggota (halaman /chat).
-- Pesan yang dihapus hanya ditandai (deleted_at), supaya browser lain tahu harus membuangnya.
-- ---------------------------------------------------------------------------
create table if not exists public.api_chat_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.api_users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.api_users(id) on delete set null
);

create index if not exists api_chat_messages_user_idx on public.api_chat_messages (user_id, created_at desc);
create index if not exists api_chat_messages_deleted_idx on public.api_chat_messages (deleted_at) where deleted_at is not null;

alter table public.api_chat_messages enable row level security;
revoke all on table public.api_chat_messages from anon, authenticated;
grant all on table public.api_chat_messages to service_role;

-- Pesan untuk akun p_user. p_after = 0: p_limit pesan terakhir. p_after > 0: pesan yang lebih baru
-- dari id itu, ditambah id pesan lama yang dihapus dalam 10 menit terakhir ('removed').
-- null bila akunnya tidak ada atau dinonaktifkan. Pesan dari akun yang dinonaktifkan tidak ikut.
create or replace function public.chat_list(p_user uuid, p_after bigint, p_limit integer)
returns json
language plpgsql
stable
set search_path = ''
as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  after_id bigint := greatest(coalesce(p_after, 0), 0);
begin
  if not exists (select 1 from public.api_users u where u.id = p_user and not u.banned) then
    return null;
  end if;
  return json_build_object(
    'messages', (
      select coalesce(json_agg(t order by t.id), '[]'::json) from (
        select m.id, m.body, m.created_at as at, u.username, u.photo, u.is_admin as admin
        from public.api_chat_messages m
        join public.api_users u on u.id = m.user_id
        where m.deleted_at is null and not u.banned and m.id > after_id
        order by m.id desc
        limit lim
      ) t
    ),
    'removed', (
      select coalesce(json_agg(m.id), '[]'::json) from public.api_chat_messages m
      where after_id > 0 and m.deleted_at > now() - interval '10 minutes' and m.id <= after_id
    )
  );
end;
$$;

-- Kirim pesan. status: 'ok' (dengan 'message'), 'none' (akun tidak ada, dinonaktifkan, atau belum
-- punya username), 'invalid' (kosong atau terlalu panjang), 'cooldown' (jeda antarpesan belum lewat),
-- 'limit' (terlalu banyak pesan dalam satu menit). 'wait' berisi detik sampai boleh mengirim lagi.
-- Hanya p_keep pesan terakhir yang disimpan; yang lebih lama dihapus.
create or replace function public.chat_post(p_user uuid, p_body text, p_cooldown integer, p_per_minute integer, p_keep integer)
returns json
language plpgsql
set search_path = ''
as $$
declare
  u public.api_users;
  txt text := btrim(coalesce(p_body, ''));
  last_at timestamptz;
  first_at timestamptz;
  recent integer;
  new_id bigint;
  new_at timestamptz;
begin
  -- Kunci baris akun supaya dua kiriman bersamaan dari akun yang sama diperiksa bergantian.
  select * into u from public.api_users where id = p_user for update;
  if not found or u.banned or coalesce(u.username, '') = '' then
    return json_build_object('status', 'none');
  end if;
  if char_length(txt) < 1 or char_length(txt) > 500 then
    return json_build_object('status', 'invalid');
  end if;

  select max(m.created_at), min(m.created_at), count(*) into last_at, first_at, recent
  from public.api_chat_messages m
  where m.user_id = p_user and m.created_at > now() - interval '1 minute';

  if last_at is not null and last_at + make_interval(secs => greatest(p_cooldown, 0)) > now() then
    return json_build_object('status', 'cooldown', 'wait',
      greatest(1, ceil(extract(epoch from (last_at + make_interval(secs => p_cooldown) - now())))::integer));
  end if;
  if recent >= greatest(p_per_minute, 1) then
    return json_build_object('status', 'limit', 'wait',
      greatest(1, ceil(extract(epoch from (first_at + interval '1 minute' - now())))::integer));
  end if;

  -- Pesan disimpan bergantian, satu per satu, supaya urutan id sama dengan urutan tersimpannya.
  -- Browser hanya meminta pesan dengan id lebih besar dari yang terakhir dilihatnya; tanpa kunci ini
  -- pesan ber-id lebih kecil bisa tersimpan belakangan dan terlewat.
  perform pg_advisory_xact_lock(hashtext('public.api_chat_messages'));
  insert into public.api_chat_messages (user_id, body) values (p_user, txt) returning id, created_at into new_id, new_at;
  delete from public.api_chat_messages where id <= new_id - greatest(p_keep, 100);

  return json_build_object('status', 'ok', 'message', json_build_object(
    'id', new_id, 'body', txt, 'at', new_at, 'username', u.username, 'photo', u.photo, 'admin', u.is_admin));
end;
$$;

-- Hapus pesan. Pemilik boleh menghapus pesannya sendiri; admin boleh menghapus pesan siapa pun.
-- false bila pesannya tidak ada, sudah dihapus, atau p_by tidak berhak.
create or replace function public.chat_delete(p_id bigint, p_by uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.api_chat_messages m
  set deleted_at = now(), deleted_by = p_by
  where m.id = p_id and m.deleted_at is null
    and exists (select 1 from public.api_users a where a.id = p_by and not a.banned and (a.id = m.user_id or a.is_admin));
  return found;
end;
$$;

revoke all on function public.chat_list(uuid, bigint, integer) from public, anon, authenticated;
revoke all on function public.chat_post(uuid, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.chat_delete(bigint, uuid) from public, anon, authenticated;
grant execute on function public.chat_list(uuid, bigint, integer) to service_role;
grant execute on function public.chat_post(uuid, text, integer, integer, integer) to service_role;
grant execute on function public.chat_delete(bigint, uuid) to service_role;
