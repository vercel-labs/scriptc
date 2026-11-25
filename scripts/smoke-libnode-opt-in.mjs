/** Exercise the opt-in libnode pack from a scratch npm installation of the
 * host's CLI, packed from this checkout: a program that calls into Node.js
 * builds and runs with the host pack installed beside it, and the same build
 * in a project without the pack fails with SC8005, whose hint names the
 * module, the @scriptc/node API that reached into Node, and this host's
 * install line. The CLI does not depend on the pack, so the two projects
 * differ only by that install.
 *
 * The pack directory is packed as a release packs it, except when it holds
 * CI's development fallback: that pack is never published and records no
 * release identity, so its packing copy omits the release-only prepack
 * verification instead of failing it and completes the identity an installed
 * pack is checked for. The program's own package, @scriptc/node, installs
 * beside the CLI in both projects, as a user installs it.
 *
 * The installed command is the natively compiled compiler, so the check
 * needs a native driver that finishes a Node island build. While this
 * checkout's driver has no such steps, the check says so and is skipped
 * (nativeDriverGap). */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isReleasePackManifest,
  withReleasePackIdentity,
  withoutReleasePrepack,
} from "../packages/libnode-common/scripts/pin.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [cliArgument, packArgument] = process.argv.slice(2);
if (cliArgument === undefined || packArgument === undefined) {
  throw new Error(
    "usage: smoke-libnode-opt-in.mjs <host CLI package directory> <host libnode pack package directory>",
  );
}
const cliDirectory = resolve(cliArgument);
const packDirectory = resolve(packArgument);

/** Why this checkout's installed command cannot pass the check yet, or null.
 * A build that calls into Node.js records the libnode pack its executable
 * loads and embeds the island modules. The Node-hosted driver does both
 * after lowering (packages/compiler/src/index.ts); the native driver, which
 * is the `scriptc` an npm installation runs, has neither step until it
 * names the pack, and then builds an executable that stops at start with
 * "no libnode pack was recorded at build time", pack installed or not. The
 * driver's own sources say which case this checkout is, so the check starts
 * to run with the change that gives the native driver the steps, and can
 * never be skipped for a driver that has them. */
function nativeDriverGap() {
  const driver = join(repository, "packages/compiler/src/native");
  const namesPack = ["prepare.ts", "compiler.ts"].some((file) =>
    /libnode/i.test(readFileSync(join(driver, file), "utf8")),
  );
  return namesPack
    ? null
    : "the natively compiled compiler, which an npm installation runs as scriptc, does not finish a Node island build yet: packages/compiler/src/native records no libnode pack and embeds no island modules, so its executable stops at start with or without the pack installed (pull request #3240 adds the steps)";
}

const gap = nativeDriverGap();
if (gap !== null) {
  if (process.env.GITHUB_ACTIONS === "true")
    console.log(`::warning title=libnode opt-in smoke test skipped::${gap}`);
  console.log(JSON.stringify({ skipped: gap }));
  process.exit(0);
}
const onWindows = process.platform === "win32";
const root = mkdtempSync(join(onWindows ? tmpdir() : "/tmp", "scriptc-libnode-opt-in-"));
const npm = onWindows ? "npm.cmd" : "npm";
const pnpm = onWindows ? "pnpm.cmd" : "pnpm";
const packIdentity = JSON.parse(readFileSync(join(packDirectory, "package.json"), "utf8"));
const env = {
  ...process.env,
  npm_config_cache: join(root, "npm-cache"),
  npm_config_update_notifier: "false",
};
// The two projects exist to show what an installed pack changes, so a pack
// named by the environment must not hide the difference.
delete env.SCRIPTC_LIBNODE;
delete env.SCRIPTC_TARGET;
const buildEnv = { ...env, SCRIPTC_CACHE_DIR: join(root, "build-cache") };

function command(executable, args, cwd, environment = env) {
  return execFileSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    shell: onWindows && executable.endsWith(".cmd"),
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** The tarball a release publishes from `directory`, with its prepack. */
function pack(directory) {
  const printed = command(pnpm, [
    "--dir",
    directory,
    "pack",
    "--pack-destination",
    root,
    "--silent",
  ])
    .trim()
    .split("\n")
    .pop();
  return join(root, basename(printed));
}

/** The directory to pack: the pack directory itself when it holds a release
 * pack, or a copy when it holds CI's development fallback. That fallback is
 * never published and records none of the release identity (package, version,
 * target) a build checks an installed pack for, so the copy drops the
 * release-only prepack verification and completes the identity from the
 * package (packages/libnode-common/scripts/pin.mjs). */
function packableDirectory(directory) {
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (isReleasePackManifest(manifest)) return { directory, development: false };
  const copy = join(root, "development-pack");
  cpSync(directory, copy, { recursive: true });
  const packageJson = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
  writeFileSync(
    join(copy, "package.json"),
    `${JSON.stringify(withoutReleasePrepack(packageJson), null, 2)}\n`,
  );
  writeFileSync(
    join(copy, "manifest.json"),
    `${JSON.stringify(withReleasePackIdentity(manifest, packageJson), null, 2)}\n`,
  );
  return { directory: copy, development: true };
}

/** A project with the release-shaped CLI installed from local tarballs. */
function project(name, tarballs) {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: `libnode-opt-in-${name}`, private: true }, null, 2)}\n`,
  );
  command(npm, ["install", "--no-audit", "--no-fund", ...tarballs], directory);
  return directory;
}

function writeProgram(directory) {
  writeFileSync(join(directory, "island.cjs"), 'exports.answer = () => "native";\n');
  writeFileSync(
    join(directory, "main.ts"),
    'import { callSync } from "@scriptc/node";\n' +
      'console.log(callSync<string>("./island.cjs", "answer"));\n',
  );
}

function build(directory) {
  const scriptc = join(directory, "node_modules", ".bin", onWindows ? "scriptc.cmd" : "scriptc");
  return spawnSync(scriptc, ["build", "main.ts", "-o", "main"], {
    cwd: directory,
    env: buildEnv,
    encoding: "utf8",
    shell: onWindows,
  });
}

try {
  const cli = JSON.parse(readFileSync(join(cliDirectory, "package.json"), "utf8"));
  const platformPackages = Object.keys(cli.dependencies ?? {}).map((name) =>
    join(repository, "packages", name.replace("@scriptc/", "")),
  );
  // The set the packed npm installation smoke installs, so the CLI is the one
  // a user gets, not a workspace path. The program imports @scriptc/node,
  // which a user installs beside the CLI, so both projects carry it.
  const tarballs = [
    join(repository, "packages/runtime"),
    ...platformPackages,
    join(repository, "packages/compiler"),
    join(repository, "packages/node"),
    cliDirectory,
    join(repository, "packages/cli"),
  ].map(pack);
  const packSource = packableDirectory(packDirectory);
  const packTarball = pack(packSource.directory);

  const installed = project("with-pack", [...tarballs, packTarball]);
  writeProgram(installed);
  const built = build(installed);
  assert.equal(built.status, 0, built.stderr);
  const ran = spawnSync(join(installed, onWindows ? "main.exe" : "main"), [], {
    cwd: installed,
    env: { ...buildEnv, PATH: "" },
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, "native\n");
  assert.equal(ran.stderr, "");

  const absent = project("without-pack", tarballs);
  writeProgram(absent);
  const refused = build(absent);
  assert.notEqual(refused.status, 0, "the build without a libnode pack must fail");
  const output = `${refused.stdout}${refused.stderr}`;
  assert.match(output, /SC8005/);
  assert.ok(output.includes("main.ts uses callSync (@scriptc/node)"), output);
  assert.ok(output.includes(`npm i ${packIdentity.name}@`), output);

  console.log(
    JSON.stringify({
      pack: `${packIdentity.name}@${packIdentity.version}`,
      pack_verification: packSource.development
        ? "skipped (development fallback)"
        : "release prepack",
      with_pack: ran.stdout.trimEnd(),
      without_pack: output.match(/error SC8005[^\n]*/)?.[0] ?? "SC8005",
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
