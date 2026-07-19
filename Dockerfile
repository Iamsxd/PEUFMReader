FROM node:24.18.0-bookworm-slim AS web-build
WORKDIR /src/web
RUN npm install --global pnpm@11.9.0
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.26.5-bookworm AS server-build
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN go test ./...
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/peufmreader ./cmd/peufmreader

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 peufmreader \
    && useradd --uid 10001 --gid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin peufmreader
WORKDIR /app
COPY --from=server-build /out/peufmreader /app/peufmreader
COPY --from=web-build /src/web/dist /app/web
ENV ADDRESS=:8080 \
    WEB_ROOT=/app/web \
    LIBRARY_ROOT=/data/library \
    STAGING_ROOT=/data/staging \
    CACHE_ROOT=/data/cache
EXPOSE 8080
USER peufmreader:peufmreader
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/app/peufmreader", "healthcheck"]
ENTRYPOINT ["/app/peufmreader"]
