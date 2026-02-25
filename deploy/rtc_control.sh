#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
BOOT_CFG_PRIMARY="/boot/firmware/config.txt"
BOOT_CFG_FALLBACK="/boot/config.txt"

die() {
  echo "$1" >&2
  exit 1
}

pick_boot_cfg() {
  if [[ -n "${SHELTR_BOOT_CONFIG:-}" && -f "${SHELTR_BOOT_CONFIG}" ]]; then
    printf '%s' "${SHELTR_BOOT_CONFIG}"
    return 0
  fi
  if [[ -f "${BOOT_CFG_PRIMARY}" ]]; then
    printf '%s' "${BOOT_CFG_PRIMARY}"
    return 0
  fi
  if [[ -f "${BOOT_CFG_FALLBACK}" ]]; then
    printf '%s' "${BOOT_CFG_FALLBACK}"
    return 0
  fi
  return 1
}

normalize_model() {
  local raw
  raw="$(printf '%s' "${1:-ds3231}" | tr '[:upper:]' '[:lower:]')"
  case "${raw}" in
    ds3231|ds1307|pcf8523|pcf8563) printf '%s' "${raw}" ;;
    *) printf 'ds3231' ;;
  esac
}

normalize_bus() {
  local raw="${1:-1}"
  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    if ((raw < 0)); then
      printf '0'
      return 0
    fi
    if ((raw > 10)); then
      printf '10'
      return 0
    fi
    printf '%s' "${raw}"
    return 0
  fi
  printf '1'
}

normalize_addr() {
  local raw number
  raw="$(printf '%s' "${1:-0x68}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${raw}" =~ ^0x[0-9a-f]{1,2}$ ]]; then
    number=$((raw))
  elif [[ "${raw}" =~ ^[0-9]+$ ]]; then
    number=$((raw))
  else
    number=$((0x68))
  fi
  if ((number < 0x03)); then
    number=$((0x03))
  elif ((number > 0x77)); then
    number=$((0x77))
  fi
  printf '0x%02x' "${number}"
}

enable_i2c_runtime() {
  if command -v raspi-config >/dev/null 2>&1; then
    raspi-config nonint do_i2c 0 >/dev/null 2>&1 || true
  fi
  modprobe i2c-dev >/dev/null 2>&1 || true
}

disable_fake_hwclock() {
  systemctl cat fake-hwclock.service >/dev/null 2>&1 && systemctl disable --now fake-hwclock.service >/dev/null 2>&1 || true
  command -v update-rc.d >/dev/null 2>&1 && update-rc.d -f fake-hwclock remove >/dev/null 2>&1 || true
}

apply_rtc() {
  local enabled model bus addr cfg tmp changed overlay_line current updated
  enabled="${1:-0}"
  model="$(normalize_model "${2:-ds3231}")"
  bus="$(normalize_bus "${3:-1}")"
  addr="$(normalize_addr "${4:-0x68}")"

  cfg="$(pick_boot_cfg)" || die "File config.txt non trovato (boot)"
  current="$(cat "${cfg}")"
  updated="${current}"

  updated="$(printf '%s\n' "${updated}" | sed -E '/^[[:space:]]*dtoverlay=i2c-rtc(,|$)/d')"
  updated="$(printf '%s\n' "${updated}" | sed -E 's/^[[:space:]]*dtparam=i2c_arm=off([[:space:]]*(#.*)?)?$/dtparam=i2c_arm=on/')"
  if ! printf '%s\n' "${updated}" | grep -Eq '^[[:space:]]*dtparam=i2c_arm=on([[:space:]]*(#.*)?)?$'; then
    updated="${updated}"$'\n''dtparam=i2c_arm=on'
  fi

  if [[ "${enabled}" == "1" ]]; then
    overlay_line="dtoverlay=i2c-rtc,${model},addr=${addr}"
    updated="${updated}"$'\n'"${overlay_line}"
  fi

  changed="0"
  if [[ "${updated}"$'\n' != "${current}"$'\n' ]]; then
    cp "${cfg}" "${cfg}.bak.$(date +%Y%m%d%H%M%S)"
    tmp="$(mktemp)"
    printf '%s\n' "${updated}" > "${tmp}"
    install -m 644 "${tmp}" "${cfg}"
    rm -f "${tmp}"
    changed="1"
  fi

  enable_i2c_runtime

  if [[ "${enabled}" == "1" ]]; then
    disable_fake_hwclock
    hwclock -r >/dev/null 2>&1 || true
    hwclock -s >/dev/null 2>&1 || true
    echo "RTC configurato: model=${model} bus=${bus} addr=${addr}"
  else
    echo "RTC disabilitato (overlay i2c-rtc rimosso)"
  fi

  if [[ "${changed}" == "1" ]]; then
    echo "Riavvio consigliato per applicare il nuovo overlay RTC."
  fi
}

sync_rtc() {
  local mode="${1:-from-rtc}"
  if ! command -v hwclock >/dev/null 2>&1; then
    die "Comando hwclock non disponibile"
  fi
  case "${mode}" in
    from-rtc)
      hwclock -s
      echo "Ora sistema sincronizzata da RTC"
      ;;
    to-rtc)
      hwclock -w
      echo "RTC sincronizzato da ora sistema"
      ;;
    *)
      die "Mode non valido: usa from-rtc o to-rtc"
      ;;
  esac
}

case "${ACTION}" in
  apply)
    apply_rtc "${2:-0}" "${3:-ds3231}" "${4:-1}" "${5:-0x68}"
    ;;
  sync)
    sync_rtc "${2:-from-rtc}"
    ;;
  *)
    die "Uso: rtc_control.sh apply <enabled 0|1> <model> <bus> <address> | rtc_control.sh sync <from-rtc|to-rtc>"
    ;;
esac
