#!/bin/sh
set -eu

node_version=$(tr -d '\r\n' < .node-version)
pnpm_version=$(sed -n 's/^ARG PNPM_VERSION=//p' Dockerfile.sandbox)
if [ -z "$node_version" ] || [ -z "$pnpm_version" ]; then
  echo "could not read the pinned Node or pnpm version" >&2
  exit 1
fi

# The managed image intentionally floats its distro and language runtimes.
# Install the same LLVM major and exact Node/pnpm tuple as the custom image so
# differential oracles do not change when the managed image is refreshed.
curl --fail --silent --show-error --location \
  https://apt.llvm.org/llvm-snapshot.gpg.key \
  --output /tmp/llvm-snapshot.gpg.key
gpg --dearmor --yes --output /tmp/llvm-snapshot.gpg /tmp/llvm-snapshot.gpg.key
sudo install -D -m 0644 /tmp/llvm-snapshot.gpg /etc/apt/keyrings/llvm-snapshot.gpg
echo "deb [signed-by=/etc/apt/keyrings/llvm-snapshot.gpg] https://apt.llvm.org/noble/ llvm-toolchain-noble-18 main" \
  | sudo tee /etc/apt/sources.list.d/llvm18.list >/dev/null

sudo apt-get update --quiet=2
sudo env DEBIAN_FRONTEND=noninteractive apt-get install --quiet=2 --yes --no-install-recommends \
  build-essential \
  ca-certificates \
  ccache \
  clang-18 \
  cmake \
  libclang-rt-18-dev \
  llvm-18 \
  xz-utils \
  zlib1g-dev
sudo rm -f /usr/local/bin/clang /usr/local/bin/clang++
sudo ln -sf clang-18 /usr/bin/clang
sudo ln -sf clang++-18 /usr/bin/clang++

node_archive="node-v${node_version}-linux-x64.tar.xz"
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v${node_version}/${node_archive}" \
  --output "/tmp/${node_archive}"
curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" \
  --output /tmp/node-SHASUMS256.txt
grep " ${node_archive}$" /tmp/node-SHASUMS256.txt \
  | sed "s# ${node_archive}# /tmp/${node_archive}#" \
  | sha256sum --check --strict -
sudo tar -xJf "/tmp/${node_archive}" --directory /usr/local --strip-components=1
sudo npm install --global "pnpm@${pnpm_version}"

rm -f "/tmp/${node_archive}" /tmp/node-SHASUMS256.txt /tmp/llvm-snapshot.gpg.key /tmp/llvm-snapshot.gpg
sudo rm -rf /var/lib/apt/lists/*

node --version
pnpm --version
clang --version | sed -n '1p'
