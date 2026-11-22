#!/usr/bin/env node
// Installs a just-published scriptc from the npm registry into a clean
// directory, builds a hello-world program with it and runs the program. The
// release runs it on every host platform while the release is only under the
// `next` dist-tag, and moves `latest` only once every platform passed
// (.github/workflows/release.yml, registry-smoke and promote). 0.4.15 would
// have stopped here: its CLIs rejected the runtime packs npm held (#4011).
//
// usage: release-registry-smoke.mjs <version>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const GREETING = "hello from scriptc";

/** The packages an install of scriptc on this host resolves, which must all be at the release's version. */
export function hostPackages(platform = process.platform, arch = process.arch) {
  const suffix = {
    "linux-x64": "linux-x64-gnu",
    "linux-arm64": "linux-arm64-gnu",
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "win32-x64": "win32-x64-msvc",
  }[`${platform}-${arch}`];
  if (suffix === undefined) throw new Error(`no scriptc release for ${platform}-${arch}`);
  return [
    "scriptc",
    `@scriptc/cli-${suffix}`,
    `@scriptc/runtime-${suffix}`,
    `@scriptc/llvm-${suffix}`,
  ];
}

/** The installed packages whose version is not the release's. */
export function versionMismatches(installed, version) {
  return Object.entries(installed)
    .filter(([, found]) => found !== version)
    .map(([name, found]) => `${name} is ${found ?? "missing"}, expected ${version}`);
}

const windows = process.platform === "win32";
// npm and the installed command are .cmd shims on Windows, which only a shell runs.
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: windows,
    stdio: ["ignore", "pipe", "inherit"],
  });

async function main() {
  const version = process.argv[2];
  if (!version) throw new Error("usage: release-registry-smoke.mjs <version>");
  const dir = mkdtempSync(join(tmpdir(), "scriptc-registry-smoke-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true }));
    // npm-available has seen every package resolve, but a registry edge can lag behind it.
    for (let attempt = 1; ; attempt++) {
      try {
        run("npm", ["install", "--no-audit", "--no-fund", `scriptc@${version}`], dir);
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        console.log(`npm install failed (attempt ${attempt}); retrying in 60 s`);
        await delay(60_000);
      }
    }
    const installed = Object.fromEntries(
      hostPackages().map((name) => {
        try {
          return [
            name,
            JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8"))
              .version,
          ];
        } catch {
          return [name, undefined];
        }
      }),
    );
    console.log(installed);
    const mismatches = versionMismatches(installed, version);
    if (mismatches.length > 0)
      throw new Error(`the install resolved other versions: ${mismatches.join("; ")}`);
    writeFileSync(
      join(dir, "hello.ts"),
      `const name: string = "scriptc";\nconsole.log(\`hello from \${name}\`);\n`,
    );
    const output = join(dir, windows ? "hello.exe" : "hello");
    console.log(run("npm", ["exec", "--no", "--", "scriptc", "--version"], dir).trim());
    run("npm", ["exec", "--no", "--", "scriptc", "build", "hello.ts", "-o", output], dir);
    const printed = execFileSync(output, { encoding: "utf8" }).trim();
    if (printed !== GREETING)
      throw new Error(`the program printed ${JSON.stringify(printed)}, expected ${GREETING}`);
    console.log(
      `scriptc@${version} installs from npm, builds and runs on ${process.platform}-${process.arch}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
