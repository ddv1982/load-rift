#!/bin/sh
set -eu

setup_url="${LOAD_RIFT_REPOSITORY_SETUP_URL:-https://github.com/ddv1982/load-rift/releases/latest/download/load-rift-repository-setup_1.0_all.deb}"
setup_deb=""

cleanup() {
  if [ -n "$setup_deb" ]; then
    rm -f "$setup_deb"
  fi
}
trap cleanup EXIT
trap 'trap - EXIT; cleanup; exit 130' HUP INT TERM

if command -v curl >/dev/null 2>&1; then
  downloader="curl"
elif command -v wget >/dev/null 2>&1; then
  downloader="wget"
else
  echo "Load Rift repository setup requires curl or wget." >&2
  exit 1
fi

setup_deb="$(mktemp "${TMPDIR:-/tmp}/load-rift-repository-setup.XXXXXX.deb")"

printf 'Downloading Load Rift repository setup package...\n'
case "$downloader" in
  curl)
    curl -fsSLo "$setup_deb" "$setup_url"
    ;;
  wget)
    wget -qO "$setup_deb" "$setup_url"
    ;;
esac
chmod 0644 "$setup_deb"

printf 'Installing Load Rift APT repository setup package...\n'
sudo apt install -y "$setup_deb"

printf '\nLoad Rift APT repository is enabled. Next run:\n'
printf '  sudo apt update\n'
printf '  sudo apt install load-rift\n'
