#!/bin/sh
# install-zig.sh <version> [<destination>]
#
# Installs the pinned Zig <version> for this host from the archive ziglang.org publishes, after checking it
# against the digest in toolchain.sha256. With <destination> it installs there, which is what the CI action does
# into the runner tool cache; without one it installs /opt/zig-<version> and links it into /usr/local/bin, which
# is what the Sandbox image does.
set -eu

version=${1:?usage: install-zig.sh <version> [destination]}
case "$version" in
  *[!0-9A-Za-z.+-]*) echo "invalid Zig version: $version" >&2; exit 1 ;;
esac

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=x86_64-linux ;;
  Linux-aarch64 | Linux-arm64) target=aarch64-linux ;;
  Darwin-x86_64) target=x86_64-macos ;;
  Darwin-arm64 | Darwin-aarch64) target=aarch64-macos ;;
  *) echo "unsupported Zig host: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

# Without a destination the install is for the whole machine, so a copy of this version already on PATH is the
# result; with one it is for a cache, which has to be filled even when the runner ships another Zig.
if [ "$#" -lt 2 ] && command -v zig >/dev/null 2>&1 && [ "$(zig version)" = "$version" ]; then
  exit 0
fi

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

# The archive's digest is pinned in toolchain.sha256, beside this script (the Sandbox image copies both).
name="zig-$target-$version.tar.xz"
archive="$temporary/$name"
# Five attempts 30 seconds apart: the download edge can refuse for a minute or two, and a retry is cheaper than
# a failed job.
curl --fail --silent --show-error --location --connect-timeout 20 --max-time 600 \
  --speed-limit 102400 --speed-time 30 --retry 4 --retry-delay 30 --retry-max-time 900 \
  "https://ziglang.org/download/$version/$name" --output "$archive"
sh "$(dirname "$0")/verify-toolchain.sh" "$archive" "$name"

destination=${2:-/opt/zig-$version}
if [ "$#" -ge 2 ]; then
  rm -rf "$destination"
  mkdir -p "$destination"
  tar -xJf "$archive" --directory "$destination" --strip-components=1
  test "$("$destination/zig" version)" = "$version"
  exit 0
fi

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

as_root rm -rf "$destination"
as_root mkdir -p "$destination"
as_root tar -xJf "$archive" --directory "$destination" --strip-components=1
as_root ln -sf "$destination/zig" /usr/local/bin/zig
test "$(zig version)" = "$version"
