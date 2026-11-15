# yanz-worker

Layanan pendamping yanz.api untuk tugas yang tidak bisa dijalankan di Vercel: tangkapan layar situs dan PDF (Chromium), konversi media (ffmpeg), hapus latar gambar, OCR, suara ke teks (Whisper), dan teks ke suara. Dijalankan dengan Docker di mesin sendiri, misalnya mesin Instabox.

## Kebutuhan mesin

- Linux 64-bit (x86_64) dengan Docker dan Docker Compose.
- RAM 4 GB atau lebih (disarankan 8 GB) dan ruang disk kosong sekitar 8 GB untuk image dan model.
- Satu port yang bisa dibuka ke internet lewat HTTPS (bawaan 8080).

## Pasang

Di mesin itu:

```bash
git clone --depth 1 -b arena/9b163253-rest-api https://github.com/aryangantenk-dev/yanz-rest-api.git yanz
cd yanz/worker
bash install.sh
```

Skrip itu membuat kunci rahasia di `worker/.env`, membangun image (pertama kali 10 sampai 20 menit), menyalakan worker di port 8080, menguji semua fitur, lalu mencetak kuncinya.

Setelah itu:

1. Buka port 8080 sebagai URL publik. Di Instabox: dashboard mesin, bagian port, publikasikan port `8080`. URL-nya berbentuk `https://8080-<id-mesin>.instabox.tech`.
2. Cek dari browser: `<URL>/health` harus menampilkan `{"ok": true, ...}`.
3. Di Vercel (Settings, Environment Variables) isi `WORKER_URL` dengan URL itu dan `WORKER_KEY` dengan kunci yang dicetak skrip. Lalu deploy ulang.

## Perintah sehari-hari

Jalankan dari folder `worker/`:

| Tujuan | Perintah |
| --- | --- |
| Lihat log | `docker compose logs --tail 100 -f worker` |
| Uji semua fitur | `docker compose exec worker python selftest.py` |
| Uji satu fitur | `docker compose exec worker python selftest.py tts transcribe` |
| Perbarui ke versi terbaru | `git pull && bash install.sh` |
| Ganti kunci | `bash install.sh --ganti-kunci`, lalu perbarui `WORKER_KEY` di Vercel |
| Matikan | `docker compose down` |

Worker menyala lagi sendiri setelah mesin dihidupkan ulang (`restart: unless-stopped`).

## Pengaturan (`worker/.env`)

| Nama | Bawaan | Fungsi |
| --- | --- | --- |
| `WORKER_KEY` | dibuat `install.sh` | Kunci yang harus dikirim yanz.api di header `x-worker-key`. Minimal 24 karakter. |
| `MAX_JOBS` | `2` | Jumlah pekerjaan berat yang berjalan bersamaan. |
| `MAX_QUEUE` | `6` | Panjang antrean; di atas itu permintaan ditolak dengan 503. |
| `FILE_TTL_SEC` | `3600` | Umur berkas hasil sebelum dihapus. |
| `MAX_INPUT_MB` | `50` | Batas ukuran berkas masukan dari tautan. |
| `MAX_MEDIA_SEC` | `600` | Batas durasi media untuk konversi. |
| `MAX_SPEECH_SEC` | `180` | Batas durasi audio untuk suara ke teks. |

Setelah mengubah `.env`, jalankan `docker compose up -d`.

Model Whisper bawaan adalah `small`. Untuk mesin yang lebih kecil, bangun dengan `docker compose build --build-arg WHISPER_MODEL=base`.

## Rute

Semua rute `/v1/*` memakai `POST` dan header `x-worker-key`. Parameter lewat query string; berkas masukan lewat `url` atau sebagai isi permintaan.

| Rute | Hasil |
| --- | --- |
| `/v1/ssweb`, `/v1/sticker`, `/v1/removebg` | Berkas gambar langsung |
| `/v1/web2pdf`, `/v1/tomp3`, `/v1/togif`, `/v1/compress`, `/v1/tts` | JSON berisi nama berkas; berkasnya di `/f/<nama>` |
| `/v1/ocr`, `/v1/transcribe` | JSON berisi teks |
| `GET /health` | Status singkat; dengan kunci, juga antrean dan sisa disk |
| `GET /f/<nama>` | Berkas hasil. Terbuka tanpa kunci; namanya acak dan berlaku `FILE_TTL_SEC` |

## Keamanan

- URL publik mesin bukan rahasia, jadi semua rute pengolah menolak permintaan tanpa kunci.
- Tautan masukan ke alamat internal (localhost, jaringan privat, alamat metadata cloud) ditolak, termasuk setelah pengalihan dan untuk setiap permintaan dari halaman yang dipotret.
- Kontainer berjalan sebagai pengguna biasa, bukan root.
