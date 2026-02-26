#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"

case "${ACTION}" in
  restart-app)
    systemctl restart --no-block sheltr.service
    echo "Restart richiesto: sheltr.service"
    ;;
  restart-newt)
    systemctl restart --no-block newt.service
    echo "Restart richiesto: newt.service"
    ;;
  restart-mqtt)
    systemctl restart --no-block sheltr-mqtt.service
    echo "Restart richiesto: sheltr-mqtt.service"
    ;;
  restart-all)
    systemctl restart --no-block sheltr.service || true
    systemctl restart --no-block newt.service || true
    systemctl restart --no-block sheltr-mqtt.service || true
    echo "Restart richiesto: sheltr.service,newt.service,sheltr-mqtt.service"
    ;;
  stop-newt)
    systemctl stop --no-block newt.service
    echo "Stop richiesto: newt.service"
    ;;
  stop-mqtt)
    systemctl stop --no-block sheltr-mqtt.service
    echo "Stop richiesto: sheltr-mqtt.service"
    ;;
  unlock-serial)
    PORT="${2:-/dev/ttyS0}"
    for unit in serial-getty@ttyS0.service serial-getty@serial0.service serial-getty@ttyAMA0.service; do
      systemctl disable --now "${unit}" >/dev/null 2>&1 || true
      systemctl mask "${unit}" >/dev/null 2>&1 || true
    done
    if command -v fuser >/dev/null 2>&1; then
      fuser -k /dev/ttyS0 >/dev/null 2>&1 || true
      [[ -e /dev/serial0 ]] && fuser -k /dev/serial0 >/dev/null 2>&1 || true
      [[ -e /dev/ttyAMA0 ]] && fuser -k /dev/ttyAMA0 >/dev/null 2>&1 || true
      [[ -n "${PORT}" && "${PORT}" != "/dev/ttyS0" && "${PORT}" != "/dev/serial0" && "${PORT}" != "/dev/ttyAMA0" ]] && fuser -k "${PORT}" >/dev/null 2>&1 || true
    fi
    echo "Seriale liberata (${PORT})"
    ;;
  apply-network)
    MODE="${2:-}"
    SSID="${3:-}"
    PASS="${4:-}"
    IP_MODE="${5:-dhcp}"
    IP_ADDR="${6:-}"
    IP_PREFIX="${7:-24}"
    IP_GATEWAY="${8:-}"
    /usr/local/lib/sheltr-admin/apply_network.sh "${MODE}" "${SSID}" "${PASS}" "${IP_MODE}" "${IP_ADDR}" "${IP_PREFIX}" "${IP_GATEWAY}"
    ;;
  apply-rtc)
    ENABLED="${2:-0}"
    MODEL="${3:-ds3231}"
    BUS="${4:-1}"
    ADDRESS="${5:-0x68}"
    /usr/local/lib/sheltr-admin/rtc_control.sh apply "${ENABLED}" "${MODEL}" "${BUS}" "${ADDRESS}"
    ;;
  sync-rtc)
    MODE="${2:-from-rtc}"
    /usr/local/lib/sheltr-admin/rtc_control.sh sync "${MODE}"
    ;;
  rtc-read)
    DEV="${2:-}"
    /usr/local/lib/sheltr-admin/rtc_control.sh read "${DEV}"
    ;;
  *)
    echo "Azione non valida" >&2
    exit 1
    ;;
esac
