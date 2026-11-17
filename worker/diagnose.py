#!/usr/bin/env python3
"""Pemeriksa mandiri untuk yanz-worker: tampilkan versi pustaka, isi folder model, dan
coba bangkitkan suara dengan beberapa susunan konfigurasi supaya ketahuan mana yang jalan.

Jalankan di mesin worker:
    cd ~/yanz/worker && .venv/bin/python diagnose.py
"""

import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_env() -> None:
    f = ROOT / ".env"
    if not f.is_file():
        return
    for raw in f.read_text("utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def versions() -> None:
    section("versi")
    print("python", sys.version.split()[0])
    import aiohttp

    print("aiohttp", aiohttp.__version__)
    try:
        import sherpa_onnx

        print("sherpa_onnx", getattr(sherpa_onnx, "__version__", "?"))
    except Exception as e:  # noqa: BLE001
        print("sherpa_onnx GAGAL:", e)
    for name in ("rapidocr", "onnxruntime", "rembg", "faster_whisper", "playwright", "PIL"):
        try:
            mod = __import__(name)
            print(name, getattr(mod, "__version__", "?"))
        except Exception as e:  # noqa: BLE001
            print(f"{name} GAGAL: {type(e).__name__}: {e}")


def files() -> None:
    section(f"isi model suara: {server.TTS_DIR}")
    if not server.TTS_DIR.is_dir():
        print("folder tidak ada")
        return
    for p in sorted(server.TTS_DIR.rglob("*"))[:40]:
        try:
            print(("DIR  " if p.is_dir() else "FILE ") + str(p.relative_to(server.TTS_DIR)), p.stat().st_size if p.is_file() else "")
        except OSError:
            pass


def tts_try(label: str, text: str, **overrides) -> None:
    import sherpa_onnx

    voice = server.find_voice()
    data_dir = overrides.get("data_dir", voice["data_dir"])
    num_threads = overrides.get("num_threads", 2)
    print(f"\n--- {label}: text={text!r} data_dir={data_dir} threads={num_threads}")
    try:
        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=voice["model"], lexicon="", tokens=voice["tokens"], data_dir=data_dir),
                provider="cpu",
                debug=True,
                num_threads=num_threads,
            ),
            max_num_sentences=2,
        )
        ok = cfg.validate()
        print("validate:", ok)
        if not ok:
            return
        engine = sherpa_onnx.OfflineTts(cfg)
        print("sample_rate:", engine.sample_rate, "num_speakers:", engine.num_speakers)
        audio = engine.generate(text, sid=0, speed=1.0)
        print("samples:", len(audio.samples), "sample_rate:", audio.sample_rate)
    except Exception:  # noqa: BLE001
        traceback.print_exc()


def main() -> int:
    versions()
    files()
    try:
        server.find_voice()
    except Exception as e:  # noqa: BLE001
        print("find_voice GAGAL:", e)
        return 1
    voice = server.find_voice()
    tts_try("bawaan", "Halo, apa kabar?")
    tts_try("tanpa tanda baca", "halo apa kabar")
    tts_try("satu thread", "Halo", num_threads=1)
    parent = str(Path(voice["data_dir"]).parent)
    if parent != voice["data_dir"]:
        tts_try("data_dir induk", "Halo", data_dir=parent)
    print("\nSelesai. Salin seluruh keluaran ini ke chat Arena bila ada yang gagal.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
