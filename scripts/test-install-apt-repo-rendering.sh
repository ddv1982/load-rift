#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
source_installer="$script_dir/install-apt-repo.sh"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/load-rift-installer-test.XXXXXX")

cleanup() {
  rm -rf "$test_root"
}
trap cleanup 0
trap 'trap - 0; cleanup; exit 130' HUP INT TERM

fail() {
  echo "install-apt-repo rendering test: $*" >&2
  exit 1
}

pinned_fingerprint="0123456789ABCDEF0123456789ABCDEF01234567"
override_fingerprint="89ABCDEF0123456789ABCDEF0123456789ABCDEF"
override_fingerprint_lower="89abcdef0123456789abcdef0123456789abcdef"
mock_sha256="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
rendered_installer="$test_root/install-apt-repo.sh"
mock_bin="$test_root/bin"
installer_tmp="$test_root/tmp"
curl_log="$test_root/curl.log"
sudo_log="$test_root/sudo.log"

mkdir "$mock_bin" "$installer_tmp"
sed "s/__LOAD_RIFT_APT_SIGNING_KEY_FINGERPRINT__/$pinned_fingerprint/g" \
  "$source_installer" >"$rendered_installer"

if grep -q '__LOAD_RIFT_APT_SIGNING_KEY_FINGERPRINT__' "$rendered_installer"; then
  fail "rendered installer still contains the signing fingerprint placeholder"
fi
if ! grep -q "$pinned_fingerprint" "$rendered_installer"; then
  fail "rendered installer does not contain the pinned signing fingerprint"
fi

cat >"$mock_bin/curl" <<'EOF'
#!/bin/sh
set -eu

fail_flag=0
silent_flag=0
show_error_flag=0
location_flag=0
output=""
url=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fail) fail_flag=1 ;;
    --silent) silent_flag=1 ;;
    --show-error) show_error_flag=1 ;;
    --location) location_flag=1 ;;
    --output)
      shift
      [ "$#" -gt 0 ] || exit 91
      output=$1
      ;;
    --*) exit 92 ;;
    *)
      [ -z "$url" ] || exit 93
      url=$1
      ;;
  esac
  shift
done

[ "$fail_flag" -eq 1 ] || exit 94
[ "$silent_flag" -eq 1 ] || exit 95
[ "$show_error_flag" -eq 1 ] || exit 96
[ "$location_flag" -eq 1 ] || exit 97
[ -n "$output" ] || exit 98
[ -n "$url" ] || exit 99
printf '%s\n' "$url" >>"$MOCK_CURL_LOG"

case "$url" in
  *.sha256)
    printf '%s  load-rift-repository-setup_1.0_all.deb\n' "$MOCK_SHA256" >"$output"
    ;;
  *.asc)
    printf '%s\n' 'mock detached signature' >"$output"
    ;;
  *.pgp)
    printf '%s\n' 'mock signing keyring' >"$output"
    ;;
  *.deb)
    printf '%s\n' 'mock repository setup package' >"$output"
    ;;
  *) exit 100 ;;
esac
EOF

cat >"$mock_bin/gpg" <<'EOF'
#!/bin/sh
set -eu

show_only=0
verify=0
for arg in "$@"; do
  case "$arg" in
    show-only) show_only=1 ;;
    --verify) verify=1 ;;
  esac
done

if [ "$show_only" -eq 1 ]; then
  printf '%s\n' 'pub:-:2048:1:0000000000000000:0:0::::::'
  printf 'fpr:::::::::%s:\n' "$MOCK_FINGERPRINT"
elif [ "$verify" -eq 1 ]; then
  printf '[GNUPG:] VALIDSIG %s 2026-07-23 0 0 0 0 0 0 1 0 00\n' "$MOCK_FINGERPRINT" >&3
fi
EOF

cat >"$mock_bin/sha256sum" <<'EOF'
#!/bin/sh
set -eu
printf '%s  %s\n' "$MOCK_SHA256" "$1"
EOF

cat >"$mock_bin/sudo" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$MOCK_SUDO_LOG"
[ "$1" = "apt" ]
[ "$2" = "install" ]
[ "$3" = "-y" ]
[ -f "$4" ]
EOF

chmod +x "$mock_bin/curl" "$mock_bin/gpg" "$mock_bin/sha256sum" "$mock_bin/sudo"

run_installer() {
  expected_fingerprint=$1
  output_file=$2
  override=${3-}

  (
    unset LOAD_RIFT_REPOSITORY_SETUP_URL
    unset LOAD_RIFT_REPOSITORY_SETUP_SHA256_URL
    unset LOAD_RIFT_REPOSITORY_SETUP_SHA256_SIG_URL
    unset LOAD_RIFT_REPOSITORY_SETUP_SIGNING_KEY_URL
    unset LOAD_RIFT_REPOSITORY_SETUP_SHA256
    unset LOAD_RIFT_REPOSITORY_SETUP_SIGNING_KEY_FINGERPRINT
    if [ -n "$override" ]; then
      LOAD_RIFT_REPOSITORY_SETUP_SIGNING_KEY_FINGERPRINT=$override
      export LOAD_RIFT_REPOSITORY_SETUP_SIGNING_KEY_FINGERPRINT
    fi
    export MOCK_CURL_LOG="$curl_log"
    export MOCK_SUDO_LOG="$sudo_log"
    export MOCK_SHA256="$mock_sha256"
    export MOCK_FINGERPRINT="$expected_fingerprint"
    PATH="$mock_bin:$PATH"
    TMPDIR="$installer_tmp"
    export PATH TMPDIR
    sh "$rendered_installer"
  ) >"$output_file" 2>&1 || {
    cat "$output_file" >&2
    fail "rendered installer failed with mocked local commands"
  }

  if ! grep -q "Authenticated Load Rift repository setup SHA256 signature with key $expected_fingerprint\." "$output_file"; then
    fail "expected signing fingerprint did not survive installer initialization"
  fi
}

run_installer "$pinned_fingerprint" "$test_root/default-pin.out"
run_installer "$override_fingerprint" "$test_root/override-pin.out" "$override_fingerprint_lower"

curl_calls=$(wc -l <"$curl_log" | tr -d '[:space:]')
[ "$curl_calls" = 8 ] || fail "expected 8 validated curl downloads, got $curl_calls"
sudo_calls=$(wc -l <"$sudo_log" | tr -d '[:space:]')
[ "$sudo_calls" = 2 ] || fail "expected two mocked sudo calls, got $sudo_calls"

for leftover in "$installer_tmp"/load-rift-repository-setup.*; do
  [ ! -d "$leftover" ] || fail "installer left temporary state behind: $leftover"
done

printf '%s\n' 'install-apt-repo rendering test passed'
