#!/bin/sh
# verify-toolchain.sh <file> [<name>]
#
# Exits 0 only when <file>'s SHA-256 is the digest scripts/toolchain.sha256 pins for <name> (default: the file's
# own name). A file with another digest, or with no line in the pin file, fails. It needs only a POSIX shell and
# sha256sum or shasum, so it runs before Node is installed and in Git Bash on Windows runners.
set -eu

file=${1:?usage: verify-toolchain.sh <file> [<name>]}
name=${2:-$(basename "$file")}
pins=${SCRIPTC_TOOLCHAIN_PINS:-$(dirname "$0")/toolchain.sha256}

expected=$(awk -v name="$name" '!/^#/ && $2 == name { print $1 }' "$pins")
case "$expected" in
  "") echo "verify-toolchain: $pins pins no SHA-256 for $name" >&2; exit 1 ;;
  *[!0-9a-f]* | *"
"*) echo "verify-toolchain: $pins has a malformed or repeated line for $name" >&2; exit 1 ;;
esac
if [ ${#expected} -ne 64 ]; then
  echo "verify-toolchain: $pins has a malformed line for $name" >&2
  exit 1
fi

# The digest is read from standard input so the output never carries the file name, which sha256sum escapes
# when it holds a backslash.
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum <"$file" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 <"$file" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$expected" ]; then
  echo "verify-toolchain: $name has SHA-256 $actual, pinned $expected" >&2
  exit 1
fi
echo "verify-toolchain: $name matches its pinned SHA-256"
