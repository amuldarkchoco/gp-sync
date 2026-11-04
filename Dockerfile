# syntax=docker/dockerfile:1
# GP Sync: back up mounted photo/video folders to Google Photos.
# Built by .github/workflows/gphotos-sync.yml and published as ghcr.io/kshanxs/gphotos-sync.

# --- Dashboard: TypeScript + Tailwind CSS, checked, tested and built with Vite+.
# Runs on the build machine's own platform; the output is plain HTML/CSS/JS for every platform.
FROM --platform=$BUILDPLATFORM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx vp check && npx vp test && npx vp build

# --- App: Python sync engine and REST API.
FROM ghcr.io/astral-sh/uv:0.13.7-python3.12-trixie-slim@sha256:d4a752dd52f42e0c508bb0b6a912f15922bb32e42f66af30671c3fdc0d759f21

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONUNBUFFERED=1 \
    MALLOC_ARENA_MAX=2 \
    HOME=/data \
    DATA_DIR=/data \
    MEDIA_DIR=/media \
    UPLOAD_DIR=/uploads \
    PORT=8527

WORKDIR /app

# Exact package versions from uv.lock (cached layer unless the lock changes).
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

COPY sync.py media.py notify.py cache.py VERSION ./
COPY --from=web /web/dist ./static

# Last, because they change on every build: everything above stays cached and unchanged.
ARG BUILD_COMMIT=""
ARG BUILD_DATE=""
ENV BUILD_COMMIT=$BUILD_COMMIT \
    BUILD_DATE=$BUILD_DATE

VOLUME ["/data"]
EXPOSE 8527
CMD ["/opt/venv/bin/python", "-u", "/app/sync.py"]
