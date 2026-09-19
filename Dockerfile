# syntax=docker/dockerfile:1

# @opendaw/app-studio is a static Vite SPA whose build also compiles the Rust/WASM audio engine
# (see packages/studio/core-wasm/build-wasm.sh) — this stage needs both Node and a Rust toolchain.
FROM node:22-bookworm AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates binaryen build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup target add wasm32-unknown-unknown \
    && rustup toolchain install nightly --profile minimal --component rust-src \
    && rustup target add wasm32-unknown-unknown --toolchain nightly

COPY package.json package-lock.json turbo.json lerna.json ./
COPY packages ./packages
COPY crates ./crates
RUN npm ci

# CI=true (unset here) is what makes vite.config.ts version assets under /main/releases/<uuid>/ for
# opendaw.studio's own multi-release Apache hosting — left unset so assets build root-relative (base "/"),
# which is what a single-revision Cloud Run deployment serving from "/" needs.
# vite's rollup chunking on this ~4300-module app exceeds Node's default old-space heap under Docker.
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npx turbo build --filter=@opendaw/app-studio...

FROM nginx:1.27-alpine AS runner
COPY --from=builder /app/packages/app/studio/dist /usr/share/nginx/html
COPY deploy/cloudrun/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=8080
EXPOSE 8080
