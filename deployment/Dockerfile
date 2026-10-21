FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY apps/web/package*.json ./
COPY apps/web/scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY apps/web ./
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    LLMR_PYTHON_DEPS=/opt/python-deps PYTHONPATH=/opt/python-deps \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY requirements.lock /build/requirements.lock
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && python -c 'from pathlib import Path; Path("/etc/apt/apt.conf.d/80-llmr-retries").write_text("Acquire::Retries \"3\";\n")'
RUN --mount=type=cache,target=/root/.cache/pip python -m pip install --timeout 120 --retries 3 --target /opt/python-deps -r /build/requirements.lock \
    && PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 python -m playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright \
    && useradd --uid 10001 --create-home research \
    && mkdir -p /var/lib/llmr/state /var/lib/llmr/uploads /var/lib/llmr/artifacts /var/lib/llmr/sandbox /var/lib/llmr/data \
    && chown -R research:research /var/lib/llmr \
    && rm -rf /build

# Minimal compatibility image: never COPY the business application or checkout.
FROM runtime AS sandbox-probe
COPY deployment/sandbox_probe /opt/research-runtime
WORKDIR /workspace
USER 10001:10001
ENV CODEX_HOME=/codex-state CODEX_SQLITE_HOME=/codex-state LLMR_PROBE_MODE=container
ENTRYPOINT ["python", "/opt/research-runtime/probe.py"]

FROM runtime AS app
WORKDIR /opt/app
COPY apps/api ./apps/api
COPY --from=web /build/web/dist ./apps/web/dist
ENV PYTHONPATH=/opt/python-deps:/opt/app \
    LLMR_STATE_ROOT=/var/lib/llmr/state LLMR_UPLOAD_ROOT=/var/lib/llmr/uploads \
    LLMR_ARTIFACT_ROOT=/var/lib/llmr/artifacts LLMR_SANDBOX_STATE_ROOT=/var/lib/llmr/sandbox \
    LLMR_DATA_ROOT=/var/lib/llmr/data LLMR_REQUIRE_EXTERNAL_STORAGE=true
USER 10001:10001
CMD ["python", "-m", "uvicorn", "apps.api.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
