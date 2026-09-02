# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the React/Vite frontend into static assets.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend

# Install dependencies first so this layer is cached unless the lockfile changes.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Build the production bundle into /app/frontend/dist.
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: assemble the backend image with all dependencies vendored in.
# The final image carries the source, Python dependencies, and the built UI,
# so it runs fully offline (no network access required at runtime).
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_MODE=demo \
    APP_DATABASE_PATH=/data/datachat.db

WORKDIR /app

# Copy the backend source, then install it (with its dependencies) from the
# project metadata. backend/pyproject.toml is the single source of truth for
# the dependency set. The layout mirrors the repo so the default paths in
# app/settings.py (root_dir = two levels above app/) resolve:
#   /app/backend/app/...   /app/config/...   /app/backend/static/...
COPY backend/ backend/
RUN pip install --upgrade pip \
    && pip install ./backend

COPY config/ config/

# Drop in the built frontend so FastAPI serves it same-origin at "/".
COPY --from=frontend /app/frontend/dist backend/static

# Writable location for the SQLite database (created/seeded on first boot).
RUN mkdir -p /data

EXPOSE 8000

# Run from backend/ so "app.main:app" and the relative config paths resolve.
WORKDIR /app/backend
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
