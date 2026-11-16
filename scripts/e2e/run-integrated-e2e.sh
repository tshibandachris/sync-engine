#!/usr/bin/env bash
set -euo pipefail

eval "$(gnome-keyring-daemon --start --components=secrets)"
printf '%s' 'eden-e2e-temporary-keyring' | gnome-keyring-daemon --unlock
npm run test:e2e:integrated
