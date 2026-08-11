#!/usr/bin/env bash
# Install without overwriting a user's existing K9s configuration.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/k9s/plugins"
bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
mkdir -p "$config_dir" "$bin_dir"
install -m 755 "$root/habibi-k9s-readonly" "$bin_dir/habibi-k9s-readonly"
install -m 644 "$root/habibi-readonly.yaml" "$config_dir/habibi-readonly.yaml"
printf 'Installed Habibi read-only K9s plugins. Restart K9s to load them.\n'
printf 'Ensure %s is on K9s PATH.\n' "$bin_dir"
