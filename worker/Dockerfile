FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    REMBG_HOME=/models/rembg \
    U2NET_HOME=/models/rembg \
    HF_HOME=/models/hf \
    TTS_DIR=/models/tts \
    DATA_DIR=/data

# Pakai paket chromium bawaan Debian (jauh lebih hemat ruang disk daripada bundel 3 browser Playwright).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ffmpeg curl bzip2 ca-certificates tini \
      libatomic1 libgomp1 libstdc++6 libgl1 libglib2.0-0 \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 app && mkdir -p /data /models && chown -R app:app /data /models

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && (pip uninstall -y opencv-python || true) \
    && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless

# Unduh model langsung sebagai pengguna `app` agar tidak menggandakan layer saat chown.
ARG WHISPER_MODEL=base
ENV WHISPER_MODEL=${WHISPER_MODEL}
USER app
RUN mkdir -p /models/rembg /models/tts /models/hf \
    && python -c "from rembg import new_session; new_session('u2net')" \
    && curl -fL --retry 3 --retry-delay 2 -sS https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-id_ID-news_tts-medium.tar.bz2 | tar xj -C /models/tts \
    && python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8')"

COPY --chown=app:app server.py selftest.py ./

EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["python", "server.py"]
