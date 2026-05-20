#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/src-tauri/bin"
DEFAULT_K6_VERSION="2.0.0"
K6_VERSION="${K6_VERSION:-$DEFAULT_K6_VERSION}"
K6_SHA256="${K6_SHA256:-}"

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
    default_sha256="2ae87d976f6cdba17185bdd980d8819a3a98e9092c6f0638cd58272ecefc8b90"
    ;;
  Linux-aarch64|Linux-arm64)
    asset_suffix="linux-arm64"
    archive_ext="tar.gz"
    tauri_target_triple="aarch64-unknown-linux-gnu"
    default_sha256="397d338c0c50821994aa51a630e511c599c2e903d00f7fa6c55a82258e7a84e6"
    ;;
  Darwin-x86_64)
    asset_suffix="macos-amd64"
    archive_ext="zip"
    tauri_target_triple="x86_64-apple-darwin"
    default_sha256="287f3b0ab9f936f20c37c649f220842385a7961ead84d695d7b5192268c61b3f"
    ;;
  Darwin-arm64|Darwin-aarch64)
    asset_suffix="macos-arm64"
    archive_ext="zip"
    tauri_target_triple="aarch64-apple-darwin"
    default_sha256="9a725f3faf8fc9de70f0bd86fb9783e6fb02f822492862846375ec0d8f2b35f7"
    ;;
  *)
    echo "Skipping automatic k6 install for unsupported platform ${uname_s}-${uname_m}." >&2
    echo "Set LOADRIFT_K6_BIN to an executable k6 path or add the correct target binary under src-tauri/bin manually." >&2
    exit 0
    ;;
esac

archive_name="k6-v${K6_VERSION}-${asset_suffix}.${archive_ext}"
download_url="https://github.com/grafana/k6/releases/download/v${K6_VERSION}/${archive_name}"
binary_path="$BIN_DIR/k6-${tauri_target_triple}"
version_file="$BIN_DIR/.k6-version"

if [[ -n "$K6_SHA256" ]]; then
  expected_sha256="$K6_SHA256"
elif [[ "$K6_VERSION" == "$DEFAULT_K6_VERSION" ]]; then
  expected_sha256="$default_sha256"
else
  echo "K6_SHA256 is required when K6_VERSION is set to ${K6_VERSION}." >&2
  echo "Built-in checksums only apply to k6 v${DEFAULT_K6_VERSION}." >&2
  exit 1
fi

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
