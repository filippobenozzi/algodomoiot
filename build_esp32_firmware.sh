#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKETCH_DIR="${ROOT_DIR}/esp32_firmware/sheltr_esp32"
SKETCH_NAME="sheltr_esp32.ino"

BUILD_DIR="${ROOT_DIR}/dist/esp32_build"
SKETCH_BUILD_DIR="${BUILD_DIR}/src/sheltr_esp32"
PUBLIC_DIR="${ROOT_DIR}/public/esp32"

FQBN_DEFAULT="esp32:esp32:esp32s3"
ESP32_INDEX_URL="${ESP32_INDEX_URL:-https://espressif.github.io/arduino-esp32/package_esp32_index.json}"
VERSION_TAG="${ESP32_FW_VERSION:-$(date +%Y.%m.%d-%H%M%S)}"
WIFI_SSID="${1:-}"
WIFI_PASS="${2:-}"
FQBN="${3:-${ESP32_FQBN:-${FQBN_DEFAULT}}}"

die() {
  echo "Errore: $1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Comando mancante: $1"
}

c_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

usage() {
  cat <<'EOF'
Uso:
  ./build_esp32_firmware.sh [WIFI_SSID] [WIFI_PASSWORD] [FQBN]

Esempi:
  ./build_esp32_firmware.sh
  ./build_esp32_firmware.sh "CasaWiFi" "PasswordSuperSegreta"
  ./build_esp32_firmware.sh "CasaWiFi" "PasswordSuperSegreta" "esp32:esp32:esp32s3"
EOF
}

chip_family_for_fqbn() {
  local fqbn_l
  fqbn_l="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "${fqbn_l}" in
    *esp32s3*) printf 'ESP32-S3\n' ;;
    *esp32s2*) printf 'ESP32-S2\n' ;;
    *esp32c3*) printf 'ESP32-C3\n' ;;
    *esp32c6*) printf 'ESP32-C6\n' ;;
    *esp32h2*) printf 'ESP32-H2\n' ;;
    *) printf 'ESP32\n' ;;
  esac
}

find_boot_app0() {
  local base found
  for base in "${HOME}/.arduino15" "${HOME}/Library/Arduino15"; do
    found="$(find "${base}/packages/esp32/hardware/esp32" -type f -name boot_app0.bin 2>/dev/null | sort -V | tail -n 1 || true)"
    if [[ -n "${found}" && -f "${found}" ]]; then
      printf '%s\n' "${found}"
      return 0
    fi
  done
  return 1
}

if [[ "${WIFI_SSID}" == "-h" || "${WIFI_SSID}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$#" -gt 3 ]]; then
  usage
  die "Parametri non validi"
fi

if [[ -n "${WIFI_SSID}" && -z "${WIFI_PASS}" ]]; then
  die "Hai passato SSID senza password WiFi"
fi

if [[ -z "${WIFI_SSID}" && -n "${WIFI_PASS}" ]]; then
  die "Hai passato password senza SSID WiFi"
fi

need_cmd arduino-cli

[[ -f "${SKETCH_DIR}/${SKETCH_NAME}" ]] || die "Sketch non trovato: ${SKETCH_DIR}/${SKETCH_NAME}"

mkdir -p "${BUILD_DIR}" "${PUBLIC_DIR}"
rm -f "${BUILD_DIR}"/*.bin "${PUBLIC_DIR}"/*.bin "${PUBLIC_DIR}/manifest.json"
rm -rf "${BUILD_DIR}/src"
mkdir -p "${SKETCH_BUILD_DIR}"
cp -R "${SKETCH_DIR}/." "${SKETCH_BUILD_DIR}/"

ssid_esc="$(c_escape "${WIFI_SSID}")"
pass_esc="$(c_escape "${WIFI_PASS}")"
cat > "${SKETCH_BUILD_DIR}/wifi_build_config.h" <<EOF
#pragma once
#define SHELTR_WIFI_SSID "${ssid_esc}"
#define SHELTR_WIFI_PASS "${pass_esc}"
EOF

echo "[1/4] Installo (o aggiorno) core ESP32..."
arduino-cli core update-index --additional-urls "${ESP32_INDEX_URL}"
arduino-cli core install esp32:esp32 --additional-urls "${ESP32_INDEX_URL}"

echo "[2/4] Compilo firmware..."
compile_cmd=(
  arduino-cli compile
  --fqbn "${FQBN}"
  --additional-urls "${ESP32_INDEX_URL}"
  --output-dir "${BUILD_DIR}"
)

if [[ -n "${WIFI_SSID}" ]]; then
  echo "    WiFi STA configurato: SSID='${WIFI_SSID}'"
else
  echo "    Nessun WiFi STA passato: firmware in modalita AP fallback."
fi

compile_cmd+=("${SKETCH_BUILD_DIR}")
"${compile_cmd[@]}"

APP_BIN="$(find "${BUILD_DIR}" -maxdepth 1 -type f -name "*.ino.bin" | head -n 1 || true)"
BOOTLOADER_BIN="$(find "${BUILD_DIR}" -maxdepth 1 -type f -name "*.ino.bootloader.bin" | head -n 1 || true)"
PARTITIONS_BIN="$(find "${BUILD_DIR}" -maxdepth 1 -type f -name "*.ino.partitions.bin" | head -n 1 || true)"
MERGED_BIN="$(find "${BUILD_DIR}" -maxdepth 1 -type f -name "*.ino.merged.bin" | head -n 1 || true)"
BOOT_APP_BIN="$(find_boot_app0 || true)"
CHIP_FAMILY="$(chip_family_for_fqbn "${FQBN}")"

[[ -n "${APP_BIN}" && -f "${APP_BIN}" ]] || die "Binario applicazione non trovato"

echo "[3/4] Copio file in public/esp32..."
cp "${APP_BIN}" "${PUBLIC_DIR}/firmware.bin"
[[ -n "${BOOTLOADER_BIN}" && -f "${BOOTLOADER_BIN}" ]] && cp "${BOOTLOADER_BIN}" "${PUBLIC_DIR}/bootloader.bin"
[[ -n "${PARTITIONS_BIN}" && -f "${PARTITIONS_BIN}" ]] && cp "${PARTITIONS_BIN}" "${PUBLIC_DIR}/partitions.bin"
[[ -n "${BOOT_APP_BIN}" && -f "${BOOT_APP_BIN}" ]] && cp "${BOOT_APP_BIN}" "${PUBLIC_DIR}/boot_app0.bin"
[[ -n "${MERGED_BIN}" && -f "${MERGED_BIN}" ]] && cp "${MERGED_BIN}" "${PUBLIC_DIR}/firmware-merged.bin"

echo "[4/4] Creo manifest Web Flasher..."
if [[ -n "${MERGED_BIN}" && -f "${MERGED_BIN}" ]]; then
  cat > "${PUBLIC_DIR}/manifest.json" <<EOF
{
  "name": "Sheltr ESP32",
  "version": "${VERSION_TAG}",
  "new_install_prompt_erase": true,
  "builds": [
    {
      "chipFamily": "${CHIP_FAMILY}",
      "parts": [
        { "path": "firmware-merged.bin", "offset": 0 }
      ]
    }
  ]
}
EOF
else
  [[ -n "${BOOTLOADER_BIN}" && -f "${BOOTLOADER_BIN}" ]] || die "Bootloader binario non trovato"
  [[ -n "${PARTITIONS_BIN}" && -f "${PARTITIONS_BIN}" ]] || die "Partitions binario non trovato"
  [[ -n "${BOOT_APP_BIN}" && -f "${BOOT_APP_BIN}" ]] || die "boot_app0.bin non trovato nel core ESP32"
  cat > "${PUBLIC_DIR}/manifest.json" <<EOF
{
  "name": "Sheltr ESP32",
  "version": "${VERSION_TAG}",
  "new_install_prompt_erase": true,
  "builds": [
    {
      "chipFamily": "${CHIP_FAMILY}",
      "parts": [
        { "path": "bootloader.bin", "offset": 4096 },
        { "path": "partitions.bin", "offset": 32768 },
        { "path": "boot_app0.bin", "offset": 57344 },
        { "path": "firmware.bin", "offset": 65536 }
      ]
    }
  ]
}
EOF
fi

echo
echo "Firmware pronto."
echo "FQBN: ${FQBN}"
echo "Chip family: ${CHIP_FAMILY}"
echo "Manifest: ${PUBLIC_DIR}/manifest.json"
echo "Pagina flash: http://<host>/esp32_flash.html"
