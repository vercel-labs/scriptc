#!/bin/sh
# install-zig.sh <version> [<cache-directory>]
#
# Installs the pinned Zig <version> for this host after checking the archive against the digest in
# toolchain.sha256. With <cache-directory> it installs <cache-directory>/<target>, the layout setup-zig uses in
# the runner tool cache, which is what the CI action fills; without one it installs /opt/zig-<version> and links
# it into /usr/local/bin, which is what the Sandbox image does.
set -eu

version=${1:?usage: install-zig.sh <version> [cache-directory]}
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

# Without a cache directory the install is for the whole machine, so a copy of this version already on PATH is
# the result; with one it is for a cache, which has to be filled even when the runner ships another Zig.
if [ "$#" -lt 2 ] && command -v zig >/dev/null 2>&1 && [ "$(zig version)" = "$version" ]; then
  exit 0
fi

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

# The archive's digest is pinned in toolchain.sha256, beside this script (the Sandbox image copies both).
name="zig-$target-$version.tar.xz"
archive="$temporary/$name"
# The official host has been slow enough to time a job out, so the community mirrors setup-zig uses come first.
# Every download is checked against the pin: a source that is slow, refuses, or serves another file is skipped,
# and the whole search is bounded so one slow source cannot hold the job.
sources="
https://pkg.machengine.org/zig
https://pkg.hexops.org/zig
https://zig.linus.dev/zig
https://zig.vortan.dev/zig
https://ziglang.org/download/$version
"
deadline=$(($(date +%s) + 600))
downloaded=
for base in $sources; do
  remaining=$((deadline - $(date +%s)))
  [ "$remaining" -gt 0 ] || break
  echo "install-zig: downloading $name from $base"
  if curl --fail --silent --show-error --location --connect-timeout 15 --max-time "$remaining" \
      --speed-limit 1024 --speed-time 60 "$base/$name" --output "$archive" &&
    sh "$(dirname "$0")/verify-toolchain.sh" "$archive" "$name"; then
    downloaded=1
    break
  fi
  echo "install-zig: $base did not provide $name; trying the next source" >&2
  rm -f "$archive"
done
if [ -z "$downloaded" ]; then
  echo "install-zig: no source provided $name" >&2
  exit 1
fi

if [ "$#" -ge 2 ]; then
  destination=$2/$target
  rm -rf "$destination"
  mkdir -p "$destination"
  tar -xJf "$archive" --directory "$destination" --strip-components=1
  test "$("$destination/zig" version)" = "$version"
  exit 0
fi

destination=/opt/zig-$version

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
