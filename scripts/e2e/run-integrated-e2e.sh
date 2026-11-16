#!/usr/bin/env bash
set -euo pipefail

eval "$(gnome-keyring-daemon --start --components=secrets)"
printf '%s' 'eden-e2e-temporary-keyring' | gnome-keyring-daemon --unlock
xvfb-run --auto-servernum --server-args='-screen 0 1600x1000x24' npm run test:e2e:integrated
