#!/bin/sh
# Install Overlord from GitHub Releases (macOS & Linux).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/geekforbrains/overlord/main/install.sh | sh
#   OVERLORD_VERSION=v0.4.0 OVERLORD_INSTALL_DIR="$HOME/.local/bin" sh install.sh
set -eu

REPO="${OVERLORD_REPO:-geekforbrains/overlord}"
INSTALL_DIR="${OVERLORD_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${OVERLORD_VERSION:-latest}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64|aarch64) target="aarch64-apple-darwin" ;;
      x86_64|amd64)  target="x86_64-apple-darwin" ;;
      *) echo "error: unsupported macOS architecture '$arch'" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64|amd64)  target="x86_64-unknown-linux-musl" ;;
      arm64|aarch64) target="aarch64-unknown-linux-musl" ;;
      *) echo "error: unsupported Linux architecture '$arch'" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "error: unsupported operating system '$os' (Overlord supports macOS and Linux)" >&2
    exit 1
    ;;
esac

archive="overlord-${target}.tar.gz"
checksum_file="${archive}.sha256"

if [ -n "${OVERLORD_RELEASE_DIR:-}" ]; then
  base_url="file://${OVERLORD_RELEASE_DIR}"
elif [ "$VERSION" = "latest" ]; then
  base_url="https://github.com/${REPO}/releases/latest/download"
else
  base_url="https://github.com/${REPO}/releases/download/${VERSION}"
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

echo "Downloading ${archive} (${VERSION})..."
curl -fsSL "${base_url}/${archive}" -o "${tmpdir}/${archive}"
curl -fsSL "${base_url}/${checksum_file}" -o "${tmpdir}/${checksum_file}"

expected_sha="$(awk '{print $1}' "${tmpdir}/${checksum_file}")"
if command -v shasum >/dev/null 2>&1; then
  actual_sha="$(shasum -a 256 "${tmpdir}/${archive}" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "${tmpdir}/${archive}" | awk '{print $1}')"
else
  echo "error: neither shasum nor sha256sum is available to verify checksum" >&2
  exit 1
fi

if [ "$expected_sha" != "$actual_sha" ]; then
  echo "error: SHA-256 mismatch for ${archive}" >&2
  echo "  expected: ${expected_sha}" >&2
  echo "  actual:   ${actual_sha}" >&2
  exit 1
fi

tar -xzf "${tmpdir}/${archive}" -C "$tmpdir"
if [ ! -f "${tmpdir}/overlord" ]; then
  echo "error: extracted archive did not contain 'overlord' binary" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
chmod 0755 "${tmpdir}/overlord"
mv -f "${tmpdir}/overlord" "${INSTALL_DIR}/overlord"

echo "Installed $("${INSTALL_DIR}/overlord" --version) to ${INSTALL_DIR}/overlord"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "note: ${INSTALL_DIR} is not on your PATH. Add it to your shell config:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

# Refresh background watcher if an Overlord service definition is already installed
plist_path="$HOME/Library/LaunchAgents/io.github.geekforbrains.overlord.watch.plist"
systemd_path="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/overlord-watch.service"
if [ -f "$plist_path" ] || [ -f "$systemd_path" ]; then
  echo "Refreshing installed Overlord background service..."
  "${INSTALL_DIR}/overlord" service install
fi
