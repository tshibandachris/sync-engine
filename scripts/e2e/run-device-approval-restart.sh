#!/usr/bin/env bash
set -euo pipefail

# Create and unlock an ephemeral OS keyring for the real Electron safeStorage test.
printf '%s' 'eden-e2e-temporary-keyring' | gnome-keyring-daemon --unlock --components=secrets

default_collection="$(busctl --user call org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service ReadAlias s default | sed -E 's/^o "([^"]+)"$/\1/')"
test -n "$default_collection"
locked_state="$(busctl --user get-property org.freedesktop.secrets "$default_collection" org.freedesktop.Secret.Collection Locked)"
test "$locked_state" = 'b false'

node scripts/e2e/device-approval-restart.cjs
