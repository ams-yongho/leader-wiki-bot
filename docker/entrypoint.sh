#!/bin/sh
set -e

# SSH known_hosts for github.com (deploy key 사용 시)
if [ -n "$SSH_PRIVATE_KEY" ]; then
  mkdir -p ~/.ssh
  echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
  ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null
fi

exec "$@"
