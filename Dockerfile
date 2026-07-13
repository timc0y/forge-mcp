FROM docker.io/cloudflare/sandbox:0.12.3

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl jq ripgrep fd-find tree python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable || true
RUN mkdir -p /workspace/repo /workspace/cache /workspace/artifacts /workspace/tmp /workspace/forge \
  && chmod 0770 /workspace /workspace/*

# Common local development ports. Production preview routing remains policy-gated.
EXPOSE 3000 4321 5173 8000 8080
