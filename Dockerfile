# syntax=docker/dockerfile:1.7

FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:0.12.4

USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ripgrep fd-find tree python3 python3-pip ca-certificates
# Keep image-level tooling outside the disposable checkout so executor loss
# never makes runtime scaffold look like repository content. Package-manager
# caches live on the reusable executor volume, not in the image or the durable
# GitHub repository.
ENV PATH="/usr/bin:${PATH}" \
  COREPACK_HOME=/opt/forge/corepack \
  npm_config_cache=/workspace/cache/npm \
  pnpm_config_store_dir=/workspace/cache/pnpm-store \
  PNPM_HOME=/workspace/cache/pnpm \
  YARN_CACHE_FOLDER=/workspace/cache/yarn \
  PIP_CACHE_DIR=/workspace/cache/pip \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_AUDIT=false
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && npm install --global --no-audit --no-fund corepack@0.34.1 \
  && corepack enable \
  && corepack prepare pnpm@10.13.1 --activate \
  && corepack prepare yarn@stable --activate \
  && node --version \
  && corepack --version
RUN mkdir -p /workspace/repo /workspace/cache /workspace/artifacts /workspace/tmp /workspace/forge /opt/forge/corepack \
  && chmod 0770 /workspace /workspace/*

# Common local development ports. Production preview routing remains policy-gated.
EXPOSE 3000 4321 5173 8000 8080
