#!/usr/bin/env node
// Loads a Linux libnode pack on the oldest runtime scriptc supports instead
// of on the runner that built it: an AlmaLinux 9 container (glibc 2.34, the
// floor docs/content/docs/platforms.mdx states, with the system libstdc++
// that distro's GCC ships). There it installs the distro's compiler,
// requires the pack's libraries to reference no GLIBCXX/CXXABI symbol
// version and need no libstdc++.so, compiles the smoke program
// (smoke/smoke.c) with that compiler, runs it against the pack and compares
// its transcript.
//
// A Linux pack is built with the manylinux_2_28 image's gcc-toolset, whose
// libstdc++ is newer than a supported host's; the pack must not inherit it
// (libnode.json's --partly-static, build.mjs). This is the check that a
// published pack actually loads and runs on a supported host.
//
//   node packages/libnode-common/scripts/floor.mjs --platform linux-x64-gnu [--image almalinux:9]
//
// Needs Docker on the runner; the libnode-packs workflow runs it for the
// Linux platforms after the build.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { packFileNames, platformInfo, repoRoot } from "./pin.mjs";
import { expectedTranscript } from "./smoke.mjs";

/** The oldest runtime a published Linux pack must load on. AlmaLinux 9 is
 * RHEL 9: glibc 2.34, and the system libstdc++ from its GCC 11. */
export const FLOOR_IMAGE = "almalinux:9";

/** The shell the container runs. It installs the compiler with its output on
 * stderr (dnf writes its "Installed:" summary to stdout even with --quiet),
 * prints the runtime it provides to stderr, fails on any C++ runtime dependency of the pack's libraries, then
 * loads the pack and writes the smoke transcript to stdout. */
export function floorScript(names) {
  return [
    "set -eu",
    "dnf install --assumeyes --quiet gcc >&2",
    "printf 'floor: glibc %s\\n' \"$(getconf GNU_LIBC_VERSION | cut -d' ' -f2)\" >&2",
    "if [ -e /usr/lib64/libstdc++.so.6 ]; then",
    "  printf 'floor: system libstdc++ %s\\n' \\",
    "    \"$(objdump -T /usr/lib64/libstdc++.so.6 | grep -o 'GLIBCXX_[0-9.]*' | sort -V | tail -n1)\" >&2",
    "fi",
    `for library in ${names.libnode} ${names.bridge}; do`,
    '  if objdump -T "/pack/$library" | grep -qE "GLIBCXX_|CXXABI_"; then',
    `    echo "floor: /pack/$library references $(objdump -T "/pack/$library" | grep -oE "GLIBCXX_[0-9.]+|CXXABI_[0-9.]+" | sort -V | tail -n1); a published pack carries its own C++ runtime" >&2`,
    "    exit 1",
    "  fi",
    '  if objdump -p "/pack/$library" | grep -qE "NEEDED[[:space:]]+libstdc\\+\\+"; then',
    '    echo "floor: /pack/$library needs libstdc++.so from the host" >&2',
    "    exit 1",
    "  fi",
    "done",
    "gcc -std=c11 -D_POSIX_C_SOURCE=200809L -D_DEFAULT_SOURCE -O2 -Wall -Werror \\",
    "  -I /src/packages/runtime/src \\",
    "  -o /tmp/smoke /src/packages/libnode-common/smoke/smoke.c -ldl",
    "/tmp/smoke /pack",
    "",
  ].join("\n");
}

/**
 * Loads `pack` in `image` and compares the smoke transcript. Returns the
 * container's status and output; does not throw for a failed load.
 *
 * @param {string} pack
 * @param {string} image
 */
export function runFloor(pack, image = FLOOR_IMAGE) {
  const manifest = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
  const names = packFileNames(manifest.target, manifest.moduleVersion);
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--volume",
      `${repoRoot}:/src:ro`,
      "--volume",
      `${resolve(pack)}:/pack:ro`,
      image,
      "sh",
      "-c",
      floorScript(names),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error === undefined ? (result.stderr ?? "") : `${result.error.message}\n`,
  };
}

/** The pack platform a package directory names (`@scriptc/libnode-<p>`). */
export function platformOf(pack) {
  const packageJson = JSON.parse(readFileSync(join(pack, "package.json"), "utf8"));
  return String(packageJson.name).replace(/^@scriptc\/libnode-/, "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { platform: { type: "string" }, pack: { type: "string" }, image: { type: "string" } },
  });
  if (values.platform === undefined && values.pack === undefined) {
    console.error(
      "usage: floor.mjs --platform <linux platform> [--pack <dir>] [--image <docker image>]",
    );
    process.exit(2);
  }
  const pack = resolve(values.pack ?? join(repoRoot, "packages", `libnode-${values.platform}`));
  if (!existsSync(join(pack, "manifest.json"))) {
    console.error(`no libnode pack in ${pack}; build it first`);
    process.exit(2);
  }
  const platform = platformOf(pack);
  if (platformInfo(platform).os !== "linux") {
    console.error(`the floor check loads Linux packs only; ${platform} is not Linux`);
    process.exit(2);
  }
  if (values.platform !== undefined && values.platform !== platform) {
    console.error(`--platform ${values.platform} does not name the pack in ${pack} (${platform})`);
    process.exit(2);
  }
  const image = values.image ?? FLOOR_IMAGE;
  const { status, stdout, stderr } = runFloor(pack, image);
  process.stderr.write(stderr);
  const expected = expectedTranscript();
  if (status !== 0 || stdout !== expected) {
    process.stderr.write(
      `the pack did not run on ${image} (exit ${status})\n--- expected\n${expected}--- actual\n${stdout}`,
    );
    process.exit(1);
  }
  process.stdout.write(`libnode pack ${platform} loads and runs on ${image}\n`);
}
