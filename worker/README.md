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
