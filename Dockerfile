FROM docker.io/cloudflare/sandbox:0.12.3

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ripgrep fd-find tree python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && npm install --global corepack@0.34.1 \
  && corepack enable \
  && node --version \
  && corepack --version \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /workspace/repo /workspace/cache /workspace/artifacts /workspace/tmp /workspace/forge \
  && chmod 0770 /workspace /workspace/*
ENV COREPACK_HOME=/workspace/cache/corepack

# Common local development ports. Production preview routing remains policy-gated.
EXPOSE 3000 4321 5173 8000 8080
