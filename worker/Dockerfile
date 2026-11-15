FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browsers \
    REMBG_HOME=/models/rembg \
    U2NET_HOME=/models/rembg \
    HF_HOME=/models/hf \
    TTS_DIR=/models/tts \
    DATA_DIR=/data

# ffmpeg untuk semua konversi media; libatomic1 dibutuhkan driver Node milik Playwright;
# libgomp1, libgl1, dan libglib2.0-0 dibutuhkan ONNX/Whisper/OpenCV;
# font Noto supaya tangkapan layar menampilkan huruf non-Latin dan emoji.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl bzip2 ca-certificates tini \
      libatomic1 libgomp1 libstdc++6 libgl1 libglib2.0-0 \
      fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && (pip uninstall -y opencv-python || true) \
    && pip install --force-reinstall --no-deps opencv-python-headless \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Model diunduh saat build supaya permintaan pertama tidak menunggu unduhan.
ARG WHISPER_MODEL=small
ENV WHISPER_MODEL=${WHISPER_MODEL}
RUN mkdir -p /models/rembg /models/tts /models/hf \
    && python -c "from rembg import new_session; new_session('u2net')" \
    && curl -fL --retry 3 --retry-delay 2 -sS https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-id_ID-news_tts-medium.tar.bz2 | tar xj -C /models/tts \
    && python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8')"

COPY server.py selftest.py ./
RUN useradd -m -u 10001 app && mkdir -p /data \
    && chmod -R a+rX /opt/browsers /models \
    && chown -R app:app /data /models
USER app

EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["python", "server.py"]
