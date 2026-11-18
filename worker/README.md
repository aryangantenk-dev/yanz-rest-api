# yanz-worker

Layanan pendamping yanz.api untuk 10 endpoint yang butuh browser, konversi media, atau model AI: tangkapan layar situs dan PDF (Chromium), konversi media (ffmpeg), hapus latar gambar, OCR, suara ke teks (Whisper), dan teks ke suara.

Dapat dipasang **langsung tanpa Docker** (otomatis di mesin kontainer seperti Instabox) maupun dengan **Docker Compose** di VPS biasa.

## Kebutuhan mesin

- Linux 64-bit (`x86_64`) berbasis Ubuntu atau Debian. Tidak wajib ada Docker.
- RAM minimal 4 GB (disarankan 8 GB) dan ruang disk kosong sekitar 5–8 GB untuk browser dan model AI.
- Satu port yang bisa dibuka ke internet lewat HTTPS (bawaan `8080`).

## Pasang di Instabox (satu baris, tanpa Docker)

Buka terminal mesin Instabox, lalu jalankan:

```bash
curl -fsSL https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main/worker/install.sh | bash
```

Atau dari hasil `git clone`:

```bash
git clone --depth 1 https://github.com/aryangantenk-dev/yanz-rest-api.git yanz
cd yanz/worker
bash install.sh
```

Skrip ini otomatis mendeteksi lingkungan Instabox/kontainer dan memasang semuanya langsung tanpa Docker (`.venv`, `ffmpeg`, Chromium, model rembg, suara Bahasa Indonesia, dan Whisper yang disesuaikan dengan kapasitas RAM mesin), menyalakan worker di latar belakang pada port `8080`, menguji ke-10 fitur, lalu mencetak `WORKER_KEY`.

Setelah selesai:

1. Buka port `8080` sebagai URL publik (**Public**) di dashboard Instabox. URL-nya berbentuk `https://8080-<id-mesin>.instabox.tech`.
2. Cek dari browser: `<URL>/health` harus menampilkan `{"ok": true, ...}`.
3. Di Vercel (**Settings → Environment Variables**) isi `WORKER_URL` dengan URL publik tadi dan `WORKER_KEY` dengan kunci yang dicetak skrip, lalu deploy ulang. Status sambungannya bisa dicek di `/api/health` (`"worker": "connected"`).

## Pasang di NAT VPS (Nauval Cloud / cloud.mui.skin)

NAT VPS hanya punya satu IPv4 publik yang dipakai bersama, jadi port `8080` tidak bisa dibuka langsung dari internet. Sambungkan lewat subdomain di panel **Managed Domain**: port tujuan `8080` (HTTP), lalu panel yang menerbitkan SSL-nya. HTTPS wajib, karena yanz.api memanggil worker lewat `https://`.

1. Deploy LXC (Ubuntu 22.04/24.04) di panel, catat IP:port SSH-nya, masuk:
   ```bash
   ssh root@<IP> -p <PORT_SSH>
   ```
2. Pasang worker (satu baris, tanpa Docker; Chromium sistem dipakai bila ada):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main/worker/install.sh | bash
   ```
   Skrip butuh RAM ±4 GB (paket **M** ke atas). Di paket **S** (2 GB) pasang dengan `MAX_JOBS=1`:
   ```bash
   MAX_JOBS=1 curl -fsSL https://raw.githubusercontent.com/aryangantenk-dev/yanz-rest-api/main/worker/install.sh | bash
   ```
3. Buka subdomain di **Managed Domain** → arahkan ke port `8080`, aktifkan SSL. Uji:
   ```bash
   curl -fsS https://<namamu>.cloud.mui.skin/health
   ```
   Harus menjawab `{"ok": true, ...}`.
4. Ambil kuncinya, lalu isi `WORKER_URL` (tanpa garis miring di akhir) dan `WORKER_KEY` di Vercel → deploy ulang:
   ```bash
   cd ~/yanz/worker && bash ctl.sh status
   ```
5. Tambahkan `worker.key` di panel **Fair-use** bila ada batas koneksi; worker hanya butuh 1 port keluar.

Catatan: NAT VPS dijeda/di-reinstall dari panel akan menghapus `~/yanz` beserta `.env` dan model. Simpan `worker/.env` (berisi `WORKER_KEY`) di tempat lain supaya tinggal salin balik dan `bash install.sh` ulang.

## Kalau halaman gagal dibuka (502)

Mulai dari diagnosa, bukan menebak. Buka:

```bash
curl -sS "https://www.yanzapi.my.id/api/tools/worker-diag?url=https://example.com&apikey=<KEY_PRO>"
```

Jawabannya memisahkan tiga hal: `steps.dns`, `steps.http` (koneksi biasa), dan `steps.chromium`. Dari situ kelihatan penyebabnya:

| Gejala | Arti | Tindakan |
| --- | --- | --- |
| `dns.ok=false` | Nama domain tidak terpecahkan dari VPS | Periksa resolver: `cat /etc/resolv.conf`, coba `getent hosts example.com` |
| `http.ok=false` | VPS memang tidak bisa keluar ke alamat itu | Cek `curl -Iv https://example.com`; jaringan NAT VPS membatasi, atau situsnya memblokir IP data center |
| `http.ok=true`, `chromium.ok=false` dengan `ERR_INTERNET_DISCONNECTED` | Ubuntu 22.04/24.04 punya Chromium **snap**, dan snap tidak bisa keluar jaringan di dalam LXC | Worker 1.2+ otomatis menolak snap dan memakai Chromium bawaan Playwright. Jalankan `bash install.sh` (mengunduh ±170 MB) lalu `bash ctl.sh restart` |
| `http.ok=true`, `chromium.ok=false` (kode lain) | Chromium di mesin itu bermasalah | Lihat kode `net::ERR_*`; jalankan `bash ctl.sh logs` |
| Semua `ok=true` | Jalur keluar sehat, masalahnya di situs target | Ulangi endpoint-nya |

Galat Chromium kini diteruskan sebagai pesan yang spesifik (`ERR_CONNECTION_REFUSED`, `ERR_TIMED_OUT`, `ERR_TOO_MANY_REDIRECTS`, dan seterusnya) supaya tidak lagi muncul "halaman tidak bisa dibuka" tanpa keterangan.

## Turnstile

`/api/tools/turnstile` mencoba dua cara berurutan:

1. **library** — pustaka `playwright-captcha` (dipasang `install.sh`; kalau gagal dipasang, worker tetap jalan).
2. **klik** — mengeklik kotak verifikasi seperti pengunjung biasa, memakai selektor bawaan atau `selector` milikmu.

Bila keduanya tidak berhasil, jawabannya tetap 422 dengan `solved: false` dan `note` yang menjelaskan sebabnya — bukan mengaku berhasil. Untuk Turnstile yang sangat ketat, jalur yang lazim dipakai adalah patch stealth (camoufox/patchright) atau solver berbasis API; keduanya tidak dipasang diam-diam di repo ini.

## Perintah sehari-hari

Jalankan dari folder `worker/` (biasanya `~/yanz-rest-api/worker`):

| Tujuan | Perintah |
| --- | --- |
| Cek status & sisa disk | `bash ctl.sh status` |
| Lihat log berjalan | `bash ctl.sh logs` |
| Nyalakan ulang worker | `bash ctl.sh restart` |
| Matikan sementara | `bash ctl.sh stop` |
| Uji semua fitur | `bash ctl.sh test` |
| Uji satu fitur | `bash ctl.sh test tts transcribe` |
| Perbarui ke versi terbaru | `git pull && bash install.sh` |
| Ganti kunci rahasia | `bash install.sh --ganti-kunci`, lalu perbarui `WORKER_KEY` di Vercel |

Di VPS dengan `systemd`, worker didaftarkan sebagai layanan `yanz-worker`. Di kontainer tanpa `systemd` seperti Instabox, `ctl.sh` menjaga proses tetap hidup di latar belakang setelah terminal ditutup dan menyalakannya kembali saat terminal dibuka setelah mesin dijeda.

## Pengaturan (`worker/.env`)

| Nama | Bawaan | Fungsi |
| --- | --- | --- |
| `WORKER_KEY` | dibuat `install.sh` | Kunci yang dikirim yanz.api di header `x-worker-key`. Minimal 24 karakter. |
| `PORT` | `8080` | Port HTTP worker. |
| `WHISPER_MODEL` | otomatis (`base` / `small`) | Ukuran model Whisper: `base` bila RAM di bawah 5 GB, `small` di atasnya. |
| `MAX_JOBS` | `2` (`1` bila RAM < 3,2 GB) | Jumlah pekerjaan berat yang berjalan bersamaan. |
| `MAX_QUEUE` | `6` | Panjang antrean; di atas itu permintaan ditolak dengan 503. |
| `FILE_TTL_SEC` | `3600` | Umur berkas hasil sebelum dihapus. |
| `MAX_INPUT_MB` | `50` | Batas ukuran berkas masukan dari tautan. |
| `MAX_MEDIA_SEC` | `600` | Batas durasi media untuk konversi. |
| `MAX_SPEECH_SEC` | `180` | Batas durasi audio untuk suara ke teks. |

Setelah mengubah `.env`, jalankan `bash ctl.sh restart` (atau `docker compose up -d` bila memakai mode Docker).

## Rute

Semua rute `/v1/*` memakai `POST` dan header `x-worker-key`. Parameter lewat query string; berkas masukan lewat `url` atau sebagai isi permintaan.

| Rute | Hasil |
| --- | --- |
| `/v1/ssweb`, `/v1/sticker`, `/v1/removebg` | Berkas gambar langsung |
| `/v1/web2pdf`, `/v1/tomp3`, `/v1/togif`, `/v1/compress`, `/v1/tts` | JSON berisi nama berkas; berkasnya di `/f/<nama>` |
| `/v1/ocr`, `/v1/transcribe` | JSON berisi teks |
| `GET /health` | Status singkat; dengan kunci yang cocok, juga daftar tugas, antrean, dan sisa disk |
| `GET /f/<nama>` | Berkas hasil. Terbuka tanpa kunci; namanya acak dan berlaku `FILE_TTL_SEC` |

## Keamanan

- URL publik mesin bukan rahasia, jadi semua rute pengolah menolak permintaan tanpa kunci.
- Tautan masukan ke alamat internal (localhost, jaringan privat, alamat metadata cloud) ditolak, termasuk setelah pengalihan dan untuk setiap permintaan dari halaman yang dipotret.
