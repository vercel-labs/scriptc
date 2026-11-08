#!/bin/sh
set -eu

version=${1:?usage: install-zig.sh <version>}
case "$version" in
  *[!0-9A-Za-z.+-]*) echo "invalid Zig version: $version" >&2; exit 1 ;;
esac

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=x86_64-linux ;;
  Linux-aarch64 | Linux-arm64) target=aarch64-linux ;;
  *) echo "unsupported Zig host: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

if command -v zig >/dev/null 2>&1 && [ "$(zig version)" = "$version" ]; then
  exit 0
fi

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

# The archive's digest is pinned in toolchain.sha256, beside this script (the Sandbox image copies both).
name="zig-$target-$version.tar.xz"
archive="$temporary/$name"
curl --fail --silent --show-error --location "https://ziglang.org/download/$version/$name" --output "$archive"
sh "$(dirname "$0")/verify-toolchain.sh" "$archive"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

destination="/opt/zig-$version"
as_root rm -rf "$destination"
as_root mkdir -p "$destination"
as_root tar -xJf "$archive" --directory "$destination" --strip-components=1
as_root ln -sf "$destination/zig" /usr/local/bin/zig
test "$(zig version)" = "$version"
