#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/src-tauri/bin"
K6_VERSION="${K6_VERSION:-1.6.1}"

uname_s="$(uname -s)"
uname_m="$(uname -m)"

verify_sha256() {
  local file_path="$1"
  local expected="$2"
  local actual=""

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file_path" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file_path" | awk '{print $1}')"
  else
    echo "Missing sha256 verifier. Install sha256sum or shasum." >&2
    exit 1
  fi

  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum verification failed for ${file_path}" >&2
    echo "Expected: ${expected}" >&2
    echo "Actual:   ${actual}" >&2
    exit 1
  fi
}

case "${uname_s}-${uname_m}" in
  Linux-x86_64)
    asset_suffix="linux-amd64"
    archive_ext="tar.gz"
    tauri_target_triple="x86_64-unknown-linux-gnu"
    expected_sha256="68df4958a1b089dc6f70a234e07c7ec818922f83b261ca24f3abf79882b13343"
    ;;
  Linux-aarch64|Linux-arm64)
    asset_suffix="linux-arm64"
    archive_ext="tar.gz"
    tauri_target_triple="aarch64-unknown-linux-gnu"
    expected_sha256="698e47804a8cf679237dc7f19813e2967e0a892d4b9387f6f6de46da259069f9"
    ;;
  Darwin-x86_64)
    asset_suffix="macos-amd64"
    archive_ext="zip"
    tauri_target_triple="x86_64-apple-darwin"
    expected_sha256="93d54398159c2cae1c5fecbb6c6abd5d12a8e43f181f2b246749b4320d08516e"
    ;;
  Darwin-arm64|Darwin-aarch64)
    asset_suffix="macos-arm64"
    archive_ext="zip"
    tauri_target_triple="aarch64-apple-darwin"
    expected_sha256="104c4b8f3784d2e1899b4f0b9d9197538d9657d9eb9a9631638a58b72b2e9434"
    ;;
  *)
    echo "Skipping automatic k6 install for unsupported platform ${uname_s}-${uname_m}."
    exit 0
    ;;
esac

archive_name="k6-v${K6_VERSION}-${asset_suffix}.${archive_ext}"
download_url="https://github.com/grafana/k6/releases/download/v${K6_VERSION}/${archive_name}"
binary_path="$BIN_DIR/k6-${tauri_target_triple}"
version_file="$BIN_DIR/.k6-version"

if [[ -x "$binary_path" ]] && [[ -f "$version_file" ]] && [[ "$(<"$version_file")" == "$K6_VERSION" ]]; then
  echo "k6 v${K6_VERSION} already installed at ${binary_path}"
  exit 0
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$BIN_DIR"

echo "Downloading k6 v${K6_VERSION} from ${download_url}"
curl -fsSL "$download_url" -o "$tmp_dir/$archive_name"
verify_sha256 "$tmp_dir/$archive_name" "$expected_sha256"

case "$archive_ext" in
  tar.gz)
    tar -xzf "$tmp_dir/$archive_name" -C "$tmp_dir"
    ;;
  zip)
    unzip -q "$tmp_dir/$archive_name" -d "$tmp_dir"
    ;;
  *)
    echo "Unsupported archive format: ${archive_ext}" >&2
    exit 1
    ;;
esac

extracted_binary="$(find "$tmp_dir" -type f -name k6 | head -n 1)"
if [[ -z "$extracted_binary" ]]; then
  echo "Failed to locate the extracted k6 binary in ${archive_name}" >&2
  exit 1
fi

cp "$extracted_binary" "$binary_path"
chmod +x "$binary_path"
printf '%s' "$K6_VERSION" > "$version_file"

echo "Installed k6 v${K6_VERSION} to ${binary_path}"
