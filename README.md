# yanz.api

REST API gratis (165 endpoint) beserta dokumentasi dan playground interaktif. Bisa dijalankan terbuka tanpa API key, atau dengan login (Google / email + kode verifikasi) dan API key berawalan `yn-` untuk setiap pengguna. Dibangun dengan Next.js 16 (App Router).

## Menjalankan lokal

```bash
npm install
npm run dev
```

## Deploy

Kode berada langsung di root repository, jadi Vercel maupun Netlify mendeteksinya sebagai proyek Next.js tanpa pengaturan tambahan (build: `npm run build`).

## Environment variable (semuanya opsional)

| Nama | Fungsi |
| --- | --- |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | URL proyek Supabase dan service role / secret key. Mengaktifkan statistik pemakaian dan pemendek URL bawaan (`/api/tools/shorturl`) lewat REST, tanpa koneksi Postgres. Jalankan `supabase/schema.sql` sekali di SQL Editor. |
| `DATABASE_URL` | Alternatif: connection string PostgreSQL biasa. Tabel dibuat otomatis. Dipakai bila variabel Supabase di atas kosong. |
| `NEXT_PUBLIC_SITE_URL` | Domain produksi untuk canonical URL, sitemap, dan Open Graph. |

| `ADMIN_KEY` | Kunci rahasia owner untuk endpoint admin (daftar blokir, buka blokir, blokir manual). Tanpa ini endpoint admin nonaktif. |
| `RATE_LIMIT_PER_MIN` | Batas permintaan per menit untuk setiap IP. Default `45`. |
| `BAN_AFTER_STRIKES` | Jumlah pelanggaran dalam 10 menit sebelum IP diblokir permanen. Default `3`. |
| `OWNER_WHATSAPP` | Nomor WhatsApp owner untuk banding blokir. Default `62895403334081`. |
| `WEB2APK_API_KEY` | Kunci API dari akunmu sendiri di layanan pembuat APK, untuk `/api/tools/web2apk`. Akun gratis mendapat 3 build per hari. Tanpa ini endpoint berjalan sebagai tamu (1 build per hari per alamat IP server), lalu menjawab 429. |
| `IZZXD_APIKEY` | API key layanan pemecah Turnstile `api.izzxd.my.id`, untuk `/api/tools/zefame-order`. Akun izzxd-nya harus paket Pro; kunci paket gratis ditolak layanan itu. Tanpa ini order hanya berjalan bila pemanggil mengirim token Turnstile sendiri lewat parameter `token`; selain itu endpoint menjawab 503. |
| `IMAGE_TTL_DAYS` | Berapa hari gambar unggahan (`/api/tools/tourl`) disimpan sebelum dihapus otomatis. Default `30`; `0` berarti selamanya. Fitur ini butuh `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. |
| `IMAGE_BUCKET` | Nama bucket Supabase Storage untuk gambar unggahan. Default `yanz-images`; dibuat otomatis. |
| `AUTH_SECRET` | Kunci acak minimal 32 karakter untuk menandatangani sesi login dan kode verifikasi. Wajib agar login aktif. |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Mengaktifkan login Google. Alamat balik yang didaftarkan di Google: `<domain>/auth/google/callback`. |
| `SMTP_USER` + `SMTP_PASS` | Mengaktifkan login email dengan kode verifikasi. Untuk Gmail isi alamat Gmail dan App password. `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default `465`), dan `MAIL_FROM` opsional. |
| `OTP_MAX_PER_HOUR` | Batas email kode per jam untuk seluruh situs. Default `100`. |
| `REQUIRE_API_KEY` | Isi `0` untuk membuka endpoint tanpa API key walau login aktif. |
| `WELPER_API_KEY` | API key payment gateway QRIS Welper (`gwk_…`) untuk menjual paket di `/paket`. Tanpa ini halaman paket tetap tampil, tetapi tombol bayar diganti ajakan menghubungi owner. |
| `WELPER_WEBHOOK_SECRET` | Secret webhook Welper (`whsec_…`) untuk memeriksa tanda tangan notifikasi pembayaran di `/api/paket/webhook`. |
| `WELPER_FEE_BEARER` | `customer` (default: pembeli menanggung biaya QRIS) atau `merchant` (biaya dipotong dari yang kamu terima). |

Tanpa database, semua endpoint lain tetap berjalan normal. Lihat `.env.example`. Status database bisa dicek di `/api/health`.

## Login dan API key

Login aktif bila tiga hal ini terpenuhi: Supabase terpasang (`supabase/schema.sql` sudah dijalankan), `AUTH_SECRET` terisi, dan minimal satu cara masuk dikonfigurasi (Google atau email). **Begitu login aktif, semua endpoint `/api/<kategori>/<nama>` menolak permintaan tanpa API key.** Selama belum lengkap, endpoint tetap terbuka dan tombol Masuk tidak ditampilkan.

- **Daftar** di `/daftar`: isi username dan email, lalu masukkan kode 6 angka yang dikirim ke email itu (berlaku 10 menit, sekali pakai, maksimal 5 kali salah). Bisa juga dengan Google; username dipilih tepat setelah akun Google terhubung.
- **Masuk** di `/login`: dengan Google atau dengan email dan kode 6 angka. Di bawah formulir ada tautan "Belum punya akun? Daftar". Akun dikenali dari alamat emailnya, jadi masuk lewat Google dan lewat email dengan alamat yang sama membuka akun yang sama.
- **Username wajib**: 3–20 karakter, huruf kecil, angka, atau garis bawah, diawali huruf, dan tidak boleh sama dengan milik akun lain. Akun yang belum punya username (termasuk akun lama) diminta mengisinya begitu masuk; API key baru ditampilkan setelah itu. Key lama tetap berfungsi.
- **Foto profil opsional**: PNG, JPG, atau WebP. Browser memotongnya menjadi persegi 256 px sebelum diunggah. Selama belum diatur, tampil gambar pengganti berisi huruf pertama username. Berkas disimpan di bucket gambar (folder `avatars/`) dan tidak ikut kedaluwarsa.
- **API key** dibuat saat akun dibuat. Bentuknya `yn-` diikuti 32 karakter acak: huruf besar, huruf kecil, angka, dan tiga simbol `_`, `.`, `-`. Contoh: `yn-7Kq2fXz9_Lm4RtHv3.pNc6Wd1J-b5YeQa0`. Hanya tiga simbol itu yang dipakai karena aman ditulis apa adanya di URL.
- **Mengirim API key**: parameter `?apikey=yn-...`, header `x-api-key: yn-...`, atau `Authorization: Bearer yn-...`.
- **Halaman `/akun`**: lihat, salin, dan ganti API key; ganti username; unggah atau hapus foto profil; keluar.
- **Halaman `/dashboard`**: statistik API key milik akun yang sedang masuk. Isinya jumlah permintaan hari ini, 7 hari, 30 hari, dan total; diagram per hari (14 hari, dengan pilihan tampil sebagai tabel); endpoint yang paling sering dipakai; tingkat berhasil. Angkanya diperbarui otomatis tiap 10 detik selama tab terbuka dan terlihat (bisa dijeda lewat sakelar "Perbarui otomatis"), dan langsung menyusul saat tab dibuka lagi. Setelah masuk, pengguna diarahkan ke halaman ini. Pengunjung yang belum masuk melihat tulisan "Kamu belum login, login dahulu untuk mengecek statistik API key kamu." beserta tautan ke `/login`.
- **Yang dihitung**: setiap permintaan ke `/api/...` yang membawa API key sah, dicatat per akun (bukan per key, jadi angkanya tetap setelah key diganti). Jawaban berkode 400 ke atas dihitung sebagai gagal. Permintaan yang ditolak sebelum key diperiksa (tanpa key, key salah, kena batas permintaan, IP diblokir) tidak dihitung. Hari dihitung menurut WIB. Rincian harian disimpan 90 hari; angka total tidak ikut terhapus. Datanya ada di tabel `api_usage` dan `api_usage_totals`.
- **Dokumentasi**: kolom API key di `/docs` terisi otomatis selama pengguna masuk, dan ikut tertulis di URL serta contoh kode setiap endpoint.
- Tautan di dalam respons yang menunjuk ke API ini sendiri (`cek`, `next`, proxy gambar komik, halaman player) otomatis membawa API key pemanggilnya.

Jawaban bila API key bermasalah:

| Kode | Arti |
| --- | --- |
| `401` | API key tidak dikirim. |
| `403` | API key tidak dikenal, sudah diganti, atau akunnya dinonaktifkan. |
| `503` | Server akun tidak dapat dihubungi, jadi API key belum bisa diperiksa. |

Hasil pemeriksaan API key disimpan sementara di memori server (60 detik), jadi key yang diganti atau akun yang dinonaktifkan bisa masih diterima paling lama satu menit.

Yang **tidak** butuh API key: `/api` (indeks), `/api/stats`, `/api/status`, `/api/health`, tautan pendek `/s/<kode>`, dan gambar unggahan `/i/<nama>`.

Untuk owner (butuh `ADMIN_KEY`):

```
/api/admin/users?key=ADMIN_KEY                    100 akun terbaru (API key disamarkan)
/api/admin/userban?email=a@b.com&key=ADMIN_KEY    nonaktifkan akun dan API key-nya
/api/admin/userunban?email=a@b.com&key=ADMIN_KEY  aktifkan lagi
```

### Akun admin

Sebuah akun bisa dijadikan admin (kolom `api_users.is_admin`). Akun admin:

- tidak terkena kuota harian, dan batas per menitnya dihitung per akun (600 per menit, atau `RATE_LIMIT_PER_MIN` kalau nilainya lebih besar); header jawabannya `x-plan: admin`,
- bisa membuka halaman `/admin` setelah login: daftar akun (cari, atur paket, nonaktifkan dan aktifkan lagi), pesanan paket, blokir IP, blokir API pengguna, blokir endpoint, dan status pembayaran,
- tidak bisa dinonaktifkan lewat `userban` sebelum status adminnya dicabut.

Status admin hanya bisa diberi atau dicabut dengan `ADMIN_KEY`, tidak dari halaman `/admin`:

```
/api/admin/setadmin?email=a@b.com&admin=1&key=ADMIN_KEY   jadikan admin
/api/admin/setadmin?email=a@b.com&admin=0&key=ADMIN_KEY   cabut
```

Semua endpoint `/api/admin/…` lain menerima `ADMIN_KEY` **atau** sesi login akun admin. Dengan sesi login, permintaan harus datang dari situs ini sendiri dan membawa header `x-requested-with: yanz-admin` (halaman `/admin` mengirimnya otomatis), jadi tautan dari situs lain tidak bisa menjalankan aksi admin. Perubahan status admin berlaku untuk API key paling lama satu menit kemudian.

Data akun ada di tabel `api_users`; kode verifikasi di `auth_otps` (yang disimpan hanya hash-nya). Sesi login adalah cookie bertanda tangan yang berlaku 30 hari.

## Paket dan kuota harian

Berlaku saat API key diwajibkan. Daftar paket ada di `src/lib/plans.ts` dan itulah satu-satunya tempat untuk mengubah nama, harga, dan kuota.

| Paket | Harga | Kuota per hari | Batas per menit |
| --- | --- | --- | --- |
| Gratis | Rp0 | 1.000 permintaan per akun | 45 per IP |
| Pro | Rp15.000 per 30 hari | 50.000 permintaan per akun | 300 per akun |

- Kuota dihitung per akun dan terisi lagi pukul 00.00 WIB. Setiap jawaban membawa header `x-plan`, `x-quota-limit`, `x-quota-remaining`, dan `x-quota-reset` (detik). Saat kuota habis API menjawab HTTP `429` berisi `quota`, `used`, `retry_after`, dan tautan `upgrade`.
- Angka pemakaian dibaca dari database paling lama tiap satu menit dan di antaranya dihitung di memori tiap instance, jadi kuota bisa terlewati sedikit saat lalu lintas tersebar ke banyak instance.
- Akun paket berbayar dihitung per akun untuk batas per menit, terpisah dari hitungan IP, dan tidak pernah memicu blokir IP.
- Membeli paket yang sama selagi masih aktif menambah masa aktifnya. Setelah masa aktif habis akun kembali ke paket Gratis dengan sendirinya; tidak ada perpanjangan otomatis.

Pembayaran memakai payment gateway QRIS [Welper](https://welper.web.id/gateway/docs):

1. Buat API key di halaman Developer Welper, lalu isi `WELPER_API_KEY` dan `WELPER_WEBHOOK_SECRET` di environment variable server.
2. Isi URL webhook di halaman Developer dengan `<domain>/api/paket/webhook`.
3. Pembeli memilih paket di `/paket`, diarahkan ke halaman bayar Welper, lalu kembali ke `/paket`. Paket aktif begitu webhook `payment.paid` diterima; halaman `/paket` juga memeriksa status tagihan langsung ke gateway sebagai cadangan bila webhook terlambat.

Pesanan disimpan di tabel `api_orders`. Untuk owner (butuh `ADMIN_KEY`):

```
/api/admin/paket?key=ADMIN_KEY                              status konfigurasi pembayaran dan koneksi ke gateway
/api/admin/orders?key=ADMIN_KEY                             100 pesanan terbaru dan total yang lunas
/api/admin/setplan?email=a@b.com&plan=pro&days=30&key=…     beri paket tanpa pembayaran (menambah masa aktif)
/api/admin/setplan?email=a@b.com&plan=free&key=…            kembalikan akun ke paket Gratis
```

## Batas pemakaian dan blokir IP

- Setiap IP boleh mengirim **45 permintaan per menit** ke `/api/*`. Sisa kuota ada di header `x-ratelimit-remaining`.
- Melewati batas menghasilkan HTTP `429` dengan field `retry_after` dan dihitung sebagai satu pelanggaran.
- Tiga pelanggaran dalam 10 menit, atau lebih dari 180 permintaan dalam satu menit, membuat IP **diblokir permanen**. Semua permintaan berikutnya dijawab HTTP `403` berisi `banned: true`, alasan, dan tautan banding ke WhatsApp owner.
- Daftar blokir disimpan di tabel `banned_ips` (Supabase/Postgres) sehingga berlaku di semua instance. Hitungan permintaan disimpan di memori tiap instance serverless, jadi batasnya bersifat perkiraan saat lalu lintas tersebar ke banyak instance.

Mengelola blokir (hanya owner, butuh `ADMIN_KEY`):

| Endpoint | Keterangan |
| --- | --- |
| `/api/admin/bans?key=…` | Daftar IP yang diblokir beserta alasan dan waktunya. |
| `/api/admin/unban?ip=1.2.3.4&key=…` | Buka blokir sebuah IP. |
| `/api/admin/ban?ip=1.2.3.4&reason=…&key=…` | Blokir IP secara manual. |

Kunci juga bisa dikirim lewat header `x-admin-key`. Cara lain: hapus baris IP tersebut dari tabel `banned_ips` di Supabase.

### Blokir API pengguna

Admin bisa memblokir API satu akun, untuk sementara atau selamanya. Caranya lewat tab **Blokir API** di halaman `/admin` (atau tombol **Blokir API** di kartu akunnya), atau:

| Endpoint | Fungsi |
| --- | --- |
| `/api/admin/keyblocks?key=…` | Daftar akun yang API-nya sedang diblokir. |
| `/api/admin/keyblock?email=…&duration=7d&reason=…&key=…` | Blokir API akun itu. `duration` berupa angka dengan satuan `m`, `h`, atau `d` (mis. `30m`, `6h`, `7d`; paling lama `3650d`), atau `permanent` untuk selamanya. Tanpa `duration`, blokirnya selamanya. `reason` opsional dan tampil ke pengguna. |
| `/api/admin/keyunblock?email=…&key=…` | Buka blokir. |

Selama diblokir:

- semua permintaan dengan API key akun itu dijawab `403` dengan `key_blocked: true`, `permanent`, `until`, dan `reason`; blokir sementara juga menyertakan header `retry-after`,
- mengganti API key tidak membuka blokir, karena yang diblokir akunnya,
- akunnya masih bisa masuk ke situs, dan halaman Dashboard serta Akun menampilkan pemberitahuan blokir beserta alasan dan waktu berakhirnya,
- permintaan yang ditolak tidak mengurangi kuota harian.

Blokir sementara berakhir sendiri pada waktunya. Memblokir ulang akun yang sama mengganti lama dan alasannya. API akun admin tidak bisa diblokir. Blokir dan pembukaan blokir berlaku paling lama satu menit kemudian, karena hasil pemeriksaan API key disimpan sebentar di tiap server.

Ini berbeda dengan `userban`, yang menonaktifkan akunnya sekaligus (tanpa batas waktu dan tanpa alasan).

### Blokir endpoint

Admin bisa menonaktifkan satu endpoint, atau satu kategori penuh, tanpa deploy ulang; misalnya saat sumber datanya sedang rusak. Caranya lewat tab **Blokir endpoint** di halaman `/admin`, atau:

| Endpoint | Fungsi |
| --- | --- |
| `/api/admin/apiblocks?key=…` | Daftar endpoint yang sedang dinonaktifkan. |
| `/api/admin/apiblock?path=film/lk21&reason=…&key=…` | Nonaktifkan satu endpoint. `path=film/*` (atau `path=film`) menonaktifkan semua endpoint kategori itu. `reason` opsional dan tampil ke pengguna. |
| `/api/admin/apiunblock?path=film/lk21&key=…` | Aktifkan lagi. |

Selama diblokir:

- permintaan ke endpoint itu dijawab `503` dengan `blocked: true`, alasan dari admin, dan header `x-endpoint-blocked: 1`; ini berlaku untuk semua pemanggil, termasuk akun admin,
- permintaan itu tidak mengurangi kuota harian dan tidak masuk statistik pemakaian, tetapi tetap terkena batas per menit,
- endpoint itu ditandai **Nonaktif** di halaman dokumentasi, `blocked: true` di `GET /api`, dan terdaftar di `GET /api/status` (terbuka tanpa API key).

Daftarnya disimpan di tabel `blocked_endpoints` dan dibaca ulang paling lama setiap 30 detik, jadi perubahan berlaku di semua server dalam waktu itu. Bila database tidak bisa dihubungi, daftar terakhir yang berhasil dibaca tetap dipakai.

## Game untuk bot WhatsApp (Baileys)

Semua game di `/api/games/*` tidak memakai sesi di server. Soal sudah menyertakan `jawaban`, `waktu`, dan `hadiah`, sehingga bot cukup menyimpan jawaban per chat. Bila tidak ingin mencocokkan sendiri, kirim jawaban pemain ke `/api/games/jawab`.

```js
const API = "https://domain-kamu.vercel.app/api";
const sesi = new Map(); // chatId -> soal

sock.ev.on("messages.upsert", async ({ messages }) => {
  const m = messages[0];
  const chat = m.key.remoteJid;
  const teks = (m.message?.conversation || m.message?.extendedTextMessage?.text || "").trim();

  if (teks === ".tebakkata") {
    const { result } = await (await fetch(`${API}/games/tebakkata`)).json();
    sesi.set(chat, result);
    setTimeout(() => sesi.delete(chat), result.waktu * 1000);
    return sock.sendMessage(chat, { text: `${result.soal}\n\nPetunjuk: ${result.petunjuk}\nWaktu: ${result.waktu} detik` });
  }

  const soal = sesi.get(chat);
  if (soal && teks) {
    const { result } = await (await fetch(`${soal.cek}${encodeURIComponent(teks)}`)).json();
    if (result.benar) {
      sesi.delete(chat);
      return sock.sendMessage(chat, { text: `Benar! Jawabannya ${result.jawaban}. +${soal.hadiah} XP` });
    }
    if (result.hampir) return sock.sendMessage(chat, { text: "Dikit lagi!" });
  }
});
```

Game bergambar (`tebakgambar`, `tebakbendera`) mengembalikan field `gambar` yang bisa langsung dikirim: `sock.sendMessage(chat, { image: { url: result.gambar }, caption: result.soal })`.

Akinator dan Tic Tac Toe juga tanpa sesi: simpan nilai `session` (Akinator) atau `board` (Tic Tac Toe) dari respons terakhir, lalu kirim kembali pada permintaan berikutnya.

## Pemendek URL

| Endpoint | Keterangan |
| --- | --- |
| `/api/tools/shorturl?url=…` | Bawaan yanz.api. Tautan pendek di domain sendiri (`/s/<kode>`) dengan hitungan klik. Butuh database. |
| `/api/tools/tinyurl?url=…&alias=…` | Lewat TinyURL (`tinyurl.com`). Tanpa database, `alias` opsional. |

## Gambar ke URL

Unggah gambar, dapat tautan yang bisa dibagikan di domain sendiri (`/i/<kode>.<ext>`).

| Cara | Contoh |
| --- | --- |
| Unggah berkas (POST multipart, field `file`) | `curl -F "file=@foto.jpg" https://domainmu/api/tools/tourl` |
| Salin dari tautan (GET) | `/api/tools/tourl?url=https://…/gambar.png` |

- Hanya PNG, JPG, GIF, dan WebP, maksimal 4 MB. Jenisnya diperiksa dari isi berkas, bukan dari namanya.
- Disimpan di Supabase Storage (bucket privat) selama `IMAGE_TTL_DAYS` hari, lalu dihapus otomatis.
- Batas unggah 10 gambar per 10 menit per IP, di luar batas permintaan umum.
- Owner bisa melihat 100 unggahan terbaru di `/api/admin/images?key=…` dan menghapus satu gambar dengan `/api/admin/delimage?name=<nama berkas>&key=…`. Gambar yang dihapus bisa masih tampil dari cache paling lama satu jam.

## Layanan gratis Zefame

Tiga endpoint di kategori Tools, diadaptasi dari skrip Zefame Free Services buatan IzzXd (kredit dan saluran pembuatnya ada di kepala `src/lib/api/zefame.ts`; jangan dihapus).

| Kebutuhan | Endpoint |
| --- | --- |
| Daftar layanan dan id-nya | `/api/tools/zefame-services?platform=tiktok` |
| Cek bisa dipesan atau masih menunggu | `/api/tools/zefame-check?service=229&link=https://www.tiktok.com/@user/video/123` |
| Kirim order | `/api/tools/zefame-order?service=229&link=https://www.tiktok.com/@user/video/123` |

- Order dijaga Cloudflare Turnstile. Tokennya diambil dari parameter `token`, atau diminta otomatis ke layanan pemecah bila `IZZXD_APIKEY` diisi. Tanpa keduanya endpoint order menjawab 503.
- Zefame memberi masa tunggu per layanan (lihat `interval` di daftar layanan). Masa tunggu dihitung per perangkat, jadi kirim `device` (UUID) yang sama saat cek dan order. Order yang masih menunggu dijawab 429.
- `link` berupa tautan lengkap atau username. Tautan pendek TikTok diuraikan lewat Zefame.

## Scraper Komik (komiku.org)

| Endpoint | Keterangan |
| --- | --- |
| `/api/komik/latest?tipe=` | Komik yang baru update chapter. `tipe` opsional: `manga`, `manhwa`, `manhua`. |
| `/api/komik/populer?periode=` | Peringkat `harian` atau `mingguan`. |
| `/api/komik/search?q=…` | Cari komik berdasarkan judul. |
| `/api/komik/list?page=&tipe=&genre=&status=&order=` | Jelajahi pustaka dengan filter. |
| `/api/komik/genre` | Daftar genre beserta jumlah komik. |
| `/api/komik/detail?slug=…` | Metadata komik (judul, sinopsis, genre, author, status, sampul) dan daftar chapter. |
| `/api/komik/chapter?slug=…&proxy=1` | URL gambar tiap halaman chapter. `proxy=1` melewatkan gambar ke proxy di bawah. |
| `/api/komik/image?url=…` | Proxy gambar, hanya untuk host komiku. |

## Scraper Anime (s2.anime-kuindo.com)

| Endpoint | Keterangan |
| --- | --- |
| `/api/anime/latest?page=` | Episode yang baru dirilis. |
| `/api/anime/home` | Semua bagian beranda (terpopuler, terbaru, top rating, rekomendasi). |
| `/api/anime/search?q=…&page=` | Cari judul anime. |
| `/api/anime/detail?slug=…` | Metadata anime dan daftar episode. Menerima slug seri maupun slug episode. |
| `/api/anime/episode?slug=…` | Link player video (`player.servers[].url`), navigasi episode, dan metadata seri. |
| `/api/anime/embed?slug=…&server=1` | Halaman HTML berisi player, untuk dipakai langsung sebagai `src` iframe. |

Contoh memasang player di halaman sendiri:

```html
<iframe src="https://domainmu/api/anime/embed?slug=kenja-no-mago-episode-12-sub-indo"
        width="100%" style="aspect-ratio:16/9;border:0" allowfullscreen></iframe>
```

Kedua scraper membaca HTML situs sumber, jadi bisa berhenti bekerja kalau situs tersebut mengubah tampilannya atau memblokir IP server.

## Film & Serial (animekuy.web.id)

| Endpoint | Keterangan |
| --- | --- |
| `/api/film/trending` | Film yang sedang ramai minggu ini. |
| `/api/film/populer` | Film populer. |
| `/api/film/series` | Serial TV populer. |
| `/api/film/search?q=…&page=` | Cari film dan serial berdasarkan judul. |
| `/api/film/detail?id=…&tipe=` | Sinopsis, genre, rating, durasi, poster, ID IMDb. Film langsung disertai link player. |
| `/api/film/season?id=…&season=` | Daftar episode satu season serial. |
| `/api/film/rekomendasi?id=…&tipe=` | Judul serupa. |
| `/api/film/player?id=…&tipe=&season=&episode=` | URL embed dari Vidy, EmbedMaster, VidSrc, dan VidLink. |
| `/api/film/embed?id=…&tipe=&season=&episode=&server=` | Halaman HTML berisi player, untuk dipakai langsung sebagai `src` iframe. |

`id` adalah ID TMDB (angka, dari daftar atau pencarian) atau ID IMDb (`tt…`). Untuk ID TMDB, `tipe` (`movie` atau `series`) wajib diisi karena nomor film dan serial bisa sama; ID IMDb tidak membutuhkannya.

Datanya dibaca dari Netlify Function milik animekuy.web.id (`/.netlify/functions/film`), yang meneruskan metadata TMDB. Videonya tidak di-host di sana maupun di sini: link player hanya URL embed penyedia pihak ketiga yang disusun dari ID judul, sama seperti yang dipasang halaman Animekuy. Ada tidaknya video, subtitle, dan iklan bergantung pada penyedia itu.

Tiap panggilan memakai jatah Netlify Functions situs sumber, jadi jawaban disimpan di memori server (daftar dan pencarian 10 menit, daftar episode 1 jam, detail dan rekomendasi 6 jam) dan panggilan keluar dibatasi 60 per menit; saat padat endpoint menjawab 429.

This product uses the TMDB API but is not endorsed or certified by TMDB.

## JKT48 (jkt48.com)

| Endpoint | Keterangan |
| --- | --- |
| `/api/jkt48/member?tim=` | Semua member: nama, panggilan, tim, status, foto. `tim` opsional: `love`, `dream`, `passion`, `trainee`. |
| `/api/jkt48/member-detail?id=…` | Profil satu member: tanggal lahir, umur, golongan darah, tinggi, zodiak, media sosial. `id` boleh angka (`31`), slug (`aurellia-31`), URL profil, atau nama/panggilan (`freya`). |
| `/api/jkt48/schedule?bulan=&tahun=&tipe=` | Jadwal satu bulan (default bulan ini). `tipe`: `show`, `event`, `exclusive`, `general`. |
| `/api/jkt48/schedule-detail?id=…` | Detail satu jadwal: lineup, member yang seitansai, harga tiket, masa penjualan, sesi acara eksklusif. |
| `/api/jkt48/theater?limit=` | Show theater mulai hari ini beserta lineup dan seitansai (maks 10). |
| `/api/jkt48/news?page=&limit=` | Berita dan pengumuman resmi, terbaru lebih dulu. |
| `/api/jkt48/news-detail?id=…` | Isi satu berita sebagai teks dan HTML. |
| `/api/jkt48/birthday?limit=&bulan=` | Ulang tahun member terdekat, atau semua yang lahir di `bulan` tertentu. |

Halaman HTML jkt48.com dijaga tantangan Cloudflare, jadi yang dibaca adalah API JSON publik milik situs itu sendiri (`https://jkt48.com/api/v1/...`, yang juga dipanggil halamannya di browser) dengan header `X-Request-Id` seperti yang dikirim halaman aslinya. Hanya data tanpa login yang diambil; tidak ada yang menyentuh akun, tiket, atau pembayaran. Semua tanggal dan jam memakai WIB.

jkt48.com menolak IP server Vercel walaupun headernya sama, tetapi menerima Supabase Edge Function. Karena itu panggilan dititipkan lewat Edge Function `film-proxy` (nama fungsi dan nama env-nya peninggalan versi lama):

1. Deploy `supabase/functions/film-proxy` ke proyek Supabase dengan verifikasi JWT dimatikan (`supabase functions deploy film-proxy --no-verify-jwt`), lalu isi secret `FILM_PROXY_KEY` dengan kunci acak (`supabase secrets set FILM_PROXY_KEY=…`).
2. Isi env `SANKA_PROXY_URL` (`https://<ref>.supabase.co/functions/v1/film-proxy`) dan `SANKA_PROXY_KEY` (kunci yang sama) di hosting, lalu deploy ulang.

Tanpa kedua env itu jkt48.com dipanggil langsung, yang hanya berhasil bila IP server hosting tidak ditolak.

Supaya tidak membebani sumber, jawaban disimpan di memori server (daftar member 30 menit, profil 12 jam, jadwal dan berita 5 menit) dan panggilan keluar dibatasi 60 per menit; saat padat endpoint menjawab 429. `birthday` membaca profil tiap member sekali lalu memakai simpanan itu, jadi panggilan pertamanya butuh beberapa detik. Kalau jkt48.com mengubah perlindungannya, endpoint menjawab 502 dengan keterangan "perlindungan anti-bot".
