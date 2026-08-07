#!/bin/sh

set -eu

: "${FORGE_REMOTE_DOCKER_SSH_TARGET:?Set FORGE_REMOTE_DOCKER_SSH_TARGET, for example timcoy@tims-mac-mini.local}"
: "${FORGE_REMOTE_DOCKER_SOCKET:?Set FORGE_REMOTE_DOCKER_SOCKET to the remote Docker socket}"

socket_path="$(mktemp -u "${TMPDIR:-/tmp}/forge-docker.XXXXXXXXXX")"
config_dir="$(mktemp -d "${TMPDIR:-/tmp}/forge-docker-config.XXXXXX")"
ssh_pid=""

cleanup() {
  if [ -n "$ssh_pid" ]; then
    kill "$ssh_pid" 2>/dev/null || true
  fi
  unlink "$socket_path" 2>/dev/null || true
  rm -rf "$config_dir"
}
trap cleanup EXIT INT TERM

# Do not inherit a local credsStore: the Docker client talks to the remote
# engine, while the registry login is performed by Wrangler during deployment.
plugin_dir="/opt/homebrew/lib/docker/cli-plugins"
if [ -d "$plugin_dir" ]; then
  printf '{\n  "auths": {},\n  "cliPluginsExtraDirs": ["%s"]\n}\n' "$plugin_dir" > "$config_dir/config.json"
else
  printf '{"auths": {}}\n' > "$config_dir/config.json"
fi

# StreamLocal forwarding lets a local Docker CLI use the remote Colima socket;
# the mini does not need to expose an insecure TCP Docker daemon.
if [ -n "${FORGE_REMOTE_DOCKER_SSH_KEY:-}" ]; then
  ssh \
    -i "$FORGE_REMOTE_DOCKER_SSH_KEY" \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o StreamLocalBindUnlink=yes \
    -N \
    -L "$socket_path:$FORGE_REMOTE_DOCKER_SOCKET" \
    "$FORGE_REMOTE_DOCKER_SSH_TARGET" &
else
  ssh \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o StreamLocalBindUnlink=yes \
    -N \
    -L "$socket_path:$FORGE_REMOTE_DOCKER_SOCKET" \
    "$FORGE_REMOTE_DOCKER_SSH_TARGET" &
fi
ssh_pid=$!

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -S "$socket_path" ]; then break; fi
  sleep 1
done
if [ ! -S "$socket_path" ]; then
  echo "Remote Docker socket did not become available: $FORGE_REMOTE_DOCKER_SSH_TARGET" >&2
  exit 1
fi

DOCKER_HOST="unix://$socket_path" DOCKER_CONFIG="$config_dir" docker buildx version >/dev/null
export DOCKER_HOST="unix://$socket_path"
export DOCKER_CONFIG="$config_dir"
pnpm run deploy
