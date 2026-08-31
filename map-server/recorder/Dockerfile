# One image, two containers: the upload endpoint and the transcriber.
#
# They share this image because they share the code that reads the queue
# directory, and they run as separate containers because they have
# opposite shapes. The endpoint must answer in milliseconds for four
# hours; the worker is busy for four hours at a time. In one process,
# a crash in the transcriber takes the uploads down mid-session.
#
# The image is large — WhisperX pulls PyTorch — so expect five or six
# gigabytes and a long first build. It is built once.

FROM python:3.11-slim

# ffmpeg decodes the browser's WebM and resamples to what the models
# want. git is here because some pinned model helpers install from a
# repository rather than a wheel.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# PyTorch first, from the index for the hardware this is being built
# for. Left to itself, pip installs the CUDA build — two extra
# gigabytes of driver libraries that a machine with no GPU will never
# load. For a GPU box, build with:
#   docker compose build --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir torch torchaudio --index-url ${TORCH_INDEX}

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py worker.py ./

ENV RECORDER_DATA=/data/sessions \
    PYTHONUNBUFFERED=1

EXPOSE 8080

# The default is the endpoint; docker-compose.yml overrides it for the
# worker. Uvicorn only — no gunicorn, no workers flag: two processes
# writing the same part files would be a race for no gain, since this
# endpoint's work is entirely disk.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
