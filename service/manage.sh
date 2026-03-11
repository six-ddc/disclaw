#!/usr/bin/env bash
set -euo pipefail

# Disclaw service management — Linux (systemd) / macOS (launchd)
# macOS: user-level LaunchAgent, runs from project directory (no sudo)
# Linux: system-level systemd service, runs from project directory (requires sudo)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OS="$(uname -s)"

# Platform-specific configuration
case "$OS" in
    Darwin)
        LABEL="com.disclaw.bot"
        PLIST_TMPL="${SCRIPT_DIR}/${LABEL}.plist"
        PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
        LOG_DIR="${PROJECT_DIR}/logs"
        GUI_DOMAIN="gui/$(id -u)"
        ;;
    Linux)
        SERVICE="disclaw.service"
        UNIT_TMPL="${SCRIPT_DIR}/disclaw.service.template"
        UNIT_DEST="/etc/systemd/system/${SERVICE}"
        ;;
    *)
        echo "Error: unsupported platform: $OS"
        exit 1
        ;;
esac

# --- Commands ---

cmd_install() {
    BUN_PATH="$(command -v bun 2>/dev/null || { echo "Error: bun not found in PATH"; exit 1; })"
    echo "Installing Disclaw on ${OS}..."

    case "$OS" in
        Darwin)
            mkdir -p "$LOG_DIR" "$(dirname "$PLIST_DEST")"
            sed -e "s|__BUN_PATH__|${BUN_PATH}|g" \
                -e "s|__WORKING_DIR__|${PROJECT_DIR}|g" \
                -e "s|__LOG_DIR__|${LOG_DIR}|g" \
                "$PLIST_TMPL" > "$PLIST_DEST"
            chmod 644 "$PLIST_DEST"
            echo "Installed plist to ${PLIST_DEST}"
            ;;
        Linux)
            # Build minimal PATH for service: standard dirs + bun dir + claude dir
            BUN_DIR="$(dirname "$BUN_PATH")"
            CLAUDE_PATH="$(command -v claude 2>/dev/null || true)"
            CLAUDE_DIR="${CLAUDE_PATH:+$(dirname "$CLAUDE_PATH")}"
            SVC_PATH="/usr/local/bin:/usr/bin:/bin"
            for d in "$BUN_DIR" "$CLAUDE_DIR"; do
                [[ -n "$d" && ":${SVC_PATH}:" != *":${d}:"* ]] && SVC_PATH="${d}:${SVC_PATH}"
            done
            sed -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
                -e "s|__BUN_PATH__|${BUN_PATH}|g" \
                -e "s|__PATH__|${SVC_PATH}|g" \
                -e "s|__HOME__|${HOME}|g" \
                "$UNIT_TMPL" | sudo tee "$UNIT_DEST" > /dev/null
            sudo systemctl daemon-reload
            sudo systemctl enable "$SERVICE"
            echo "Installed and enabled ${SERVICE}"
            ;;
    esac

    echo "Done. (dir: ${PROJECT_DIR}, bun: ${BUN_PATH})"
    echo "Start with: make start"
}

cmd_uninstall() {
    echo "Uninstalling Disclaw service..."

    case "$OS" in
        Darwin)
            launchctl bootout "${GUI_DOMAIN}/${LABEL}" 2>/dev/null || true
            rm -f "$PLIST_DEST"
            ;;
        Linux)
            sudo systemctl stop "$SERVICE" 2>/dev/null || true
            sudo systemctl disable "$SERVICE" 2>/dev/null || true
            sudo rm -f "$UNIT_DEST"
            sudo systemctl daemon-reload
            ;;
    esac

    echo "Service removed."
}

cmd_start() {
    echo "Starting Disclaw..."

    case "$OS" in
        Darwin)
            launchctl bootstrap "${GUI_DOMAIN}" "$PLIST_DEST" 2>/dev/null || \
                echo "Already loaded. Use 'make restart' to restart."
            ;;
        Linux)
            sudo systemctl start "$SERVICE"
            ;;
    esac
}

cmd_stop() {
    echo "Stopping Disclaw..."

    case "$OS" in
        Darwin)
            launchctl bootout "${GUI_DOMAIN}/${LABEL}"
            ;;
        Linux)
            sudo systemctl stop "$SERVICE"
            ;;
    esac
}

cmd_restart() {
    echo "Restarting Disclaw..."

    case "$OS" in
        Darwin)
            if launchctl print "${GUI_DOMAIN}/${LABEL}" &>/dev/null; then
                launchctl kickstart -kp "${GUI_DOMAIN}/${LABEL}"
            else
                launchctl bootstrap "${GUI_DOMAIN}" "$PLIST_DEST"
            fi
            ;;
        Linux)
            sudo systemctl restart "$SERVICE"
            ;;
    esac
}

cmd_status() {
    case "$OS" in
        Darwin)
            if launchctl print "${GUI_DOMAIN}/${LABEL}" 2>/dev/null; then
                :
            else
                echo "Service is not loaded."
                echo "Run: make install && make start"
                return 1
            fi
            ;;
        Linux)
            systemctl status "$SERVICE" --no-pager
            ;;
    esac
}

cmd_logs() {
    case "$OS" in
        Darwin)
            if [[ -d "$LOG_DIR" ]]; then
                tail -f "${LOG_DIR}/stdout.log" "${LOG_DIR}/stderr.log" 2>/dev/null || \
                    echo "No log files yet at: ${LOG_DIR}"
            else
                echo "Log directory not found: ${LOG_DIR}"
                echo "Is the service installed? Run: make install"
            fi
            ;;
        Linux)
            journalctl -u "$SERVICE" -f --no-pager
            ;;
    esac
}

# --- Main ---

case "${1:-help}" in
    install)   cmd_install ;;
    uninstall) cmd_uninstall ;;
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_restart ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    help|*)
        cat <<'EOF'
Disclaw service management (auto-detects Linux/macOS)

Usage: manage.sh <command>

Commands:
  install     Register as service (macOS: LaunchAgent, Linux: systemd)
  uninstall   Remove service registration
  start       Start the service
  stop        Stop the service
  restart     Restart the service
  status      Show service status
  logs        Follow service logs
EOF
        [[ "${1:-}" == "help" ]] && exit 0 || exit 1
        ;;
esac
