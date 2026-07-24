#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/src-tauri/bin"
DEFAULT_K6_VERSION="2.1.0"
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

verify_k6_version() {
  local candidate="$1"
  local output=""

  if ! output="$("$candidate" version 2>&1)"; then
    echo "Failed to execute the installed k6 binary at ${candidate}." >&2
    return 1
  fi

  case "$output" in
    *" v${K6_VERSION} "*)
      echo "Verified ${output}"
      ;;
    *)
      echo "Installed k6 binary did not report expected version v${K6_VERSION}." >&2
      echo "Actual: ${output}" >&2
      return 1
      ;;
  esac
}

case "${uname_s}-${uname_m}" in
  Linux-x86_64)
    asset_suffix="linux-amd64"
    archive_ext="tar.gz"
    tauri_target_triple="x86_64-unknown-linux-gnu"
    default_sha256="295d961ebfca306f295f1133068dcd403a8171c87f387928f5f30b0fbcff858a"
    ;;
  Linux-aarch64|Linux-arm64)
    asset_suffix="linux-arm64"
    archive_ext="tar.gz"
    tauri_target_triple="aarch64-unknown-linux-gnu"
    default_sha256="191fa8d89512a4e5083f3fabcb4c3828af9f5b9eee016de8443f6473c029ffb5"
    ;;
  Darwin-x86_64)
    asset_suffix="macos-amd64"
    archive_ext="zip"
    tauri_target_triple="x86_64-apple-darwin"
    default_sha256="a600f44ad411ad5f5f7d178405d9956dac34c43563341396f1017ae7f79221a9"
    ;;
  Darwin-arm64|Darwin-aarch64)
    asset_suffix="macos-arm64"
    archive_ext="zip"
    tauri_target_triple="aarch64-apple-darwin"
    default_sha256="7388e449816fdb98afe65f349f3983304ba5e14f73b6bee0d7f96c4e3e6b8942"
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
  if verify_k6_version "$binary_path"; then
    echo "k6 v${K6_VERSION} already installed at ${binary_path}"
    exit 0
  fi
  echo "Replacing cached k6 binary after version verification failed." >&2
  rm -f "$binary_path" "$version_file"
fi

tmp_dir="$(mktemp -d)"
staged_binary="$BIN_DIR/.k6-${tauri_target_triple}.tmp.$$"
staged_version_file="${version_file}.tmp.$$"
cleanup() {
  rm -rf "$tmp_dir"
  rm -f "$staged_binary" "$staged_version_file"
}
trap cleanup EXIT

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

chmod +x "$extracted_binary"
verify_k6_version "$extracted_binary"
cp "$extracted_binary" "$staged_binary"
chmod +x "$staged_binary"
printf '%s' "$K6_VERSION" > "$staged_version_file"
mv -f "$staged_binary" "$binary_path"
mv -f "$staged_version_file" "$version_file"

echo "Installed k6 v${K6_VERSION} to ${binary_path}"
