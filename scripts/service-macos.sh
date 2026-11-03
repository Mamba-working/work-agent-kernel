#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
label="com.mamba.work-agent-kernel"
service_target="gui/$(id -u)/$label"
plist_path="$HOME/Library/LaunchAgents/$label.plist"
env_file="${WORK_AGENT_ENV_FILE:-$HOME/.config/work-agent-kernel/live.env}"

case "${1:-status}" in
  install)
    node_bin="$(node --input-type=module -e 'import {realpathSync} from "node:fs"; process.stdout.write(realpathSync(process.execPath));')"
    state_dir="$(cd "$repo_dir" && "$node_bin" --env-file="$env_file" --input-type=module -e 'import {stateDirectory} from "./src/live/config.ts"; process.stdout.write(stateDirectory());')"
    mkdir -p "$state_dir" "$(dirname "$plist_path")"
    python3 - "$plist_path" "$node_bin" "$env_file" "$repo_dir" "$state_dir" "$label" "$PATH" <<'PY'
import os, plistlib, sys
path, node, env, repo, state, label, search_path = sys.argv[1:]
with open(path, 'wb') as f:
    plistlib.dump({
        'Label': label,
        'ProgramArguments': [node, '--env-file=' + env, repo + '/src/live/cli.ts', 'serve'],
        'WorkingDirectory': repo,
        'EnvironmentVariables': {'PATH': search_path},
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10, 'ExitTimeOut': 10,
        'StandardOutPath': state + '/service.log', 'StandardErrorPath': state + '/service-error.log',
    }, f)
os.chmod(path, 0o600)
print(path)
PY
    launchctl bootstrap "gui/$(id -u)" "$plist_path"
    ;;
  start) launchctl bootstrap "gui/$(id -u)" "$plist_path" ;;
  stop) launchctl bootout "$service_target" ;;
  restart) launchctl kickstart -k "$service_target" ;;
  status) launchctl print "$service_target" ;;
  *) printf '%s\n' 'Usage: scripts/service-macos.sh install | start | stop | restart | status' >&2; exit 2 ;;
esac
