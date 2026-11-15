import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load } from "js-yaml";
import { expect, test, vi } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const workflows = readdirSync(join(root, ".github", "workflows"))
  .filter((name) => name.endsWith(".yml"))
  .map((name) => `.github/workflows/${name}`);
const actions = readdirSync(join(root, ".github", "actions")).map(
  (name) => `.github/actions/${name}/action.yml`,
);
const pinFile = "scripts/toolchain.sha256";
const verifier = join(root, "scripts", "verify-toolchain.sh");

test("every action is pinned to a commit, with its version in a comment", () => {
  const unpinned: string[] = [];
  for (const path of [...workflows, ...actions]) {
    for (const [index, line] of read(path).split("\n").entries()) {
      const uses = /^\s*(?:- )?uses:\s*(.*)$/.exec(line)?.[1];
      if (uses === undefined || uses.startsWith("./")) continue;
      // owner/repo[/path]@<40 hex digits> # v<version>
      if (!/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # v\d+(?:\.\d+){0,2}$/.test(uses)) {
        unpinned.push(`${path}:${index + 1}: ${uses}`);
      }
    }
  }
  expect(unpinned).toEqual([]);
});

test("every workflow limits the default token", () => {
  for (const path of workflows) {
    const workflow = load(read(path)) as { permissions?: Record<string, string> };
    expect(workflow.permissions, `${path} needs top-level permissions`).toBeDefined();
  }
  // CI and the release's build jobs only read the repository. Publishing, artifact reuse and the GitHub release
  // ask for more in their own jobs.
  for (const path of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const workflow = load(read(path)) as { permissions: Record<string, string> };
    expect(workflow.permissions, path).toEqual({ contents: "read" });
  }
  const release = load(read(".github/workflows/release.yml")) as {
    jobs: Record<string, { permissions?: Record<string, string> }>;
  };
  expect(release.jobs["publish"]!.permissions).toMatchObject({
    "id-token": "write",
    actions: "read",
  });
  expect(release.jobs["github-release"]!.permissions).toMatchObject({ contents: "write" });
});

test("the pin file has one well-formed line per archive", () => {
  const names: string[] = [];
  for (const line of read(pinFile).split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    expect(match, line).not.toBeNull();
    names.push(match![2]!);
  }
  expect(new Set(names).size).toBe(names.length);
  // The versions the fetching code names today.
  const node = read(".node-version").trim();
  const zig = /^ARG ZIG_VERSION=(.+)$/m.exec(read("Dockerfile.sandbox"))![1]!;
  expect(names).toEqual(
    expect.arrayContaining([
      `node-v${node}-linux-x64.tar.xz`,
      `zig-x86_64-linux-${zig}.tar.xz`,
      `zig-aarch64-linux-${zig}.tar.xz`,
      "llvm-snapshot.gpg.key",
    ]),
  );
});

test("the verifier and the pin file keep LF line endings in every checkout", () => {
  // A Windows checkout that converts line endings must not hand sh and
  // sha256sum a carriage return at the end of every line.
  const attributes = read(".gitattributes").split(/\r?\n/);
  for (const path of ["scripts/verify-toolchain.sh", pinFile]) {
    expect(attributes, path).toContain(`${path} text eol=lf`);
    expect(read(path), path).not.toContain("\r");
  }
});

test("every download of a toolchain archive is checked against the pin file", () => {
  // A file that fetches from one of these origins must also run the verifier.
  const origins =
    /github\.com\/llvm\/llvm-project\/releases\/download|nodejs\.org\/dist\/.*\.tar|ziglang\.org\/download|apt\.llvm\.org\/llvm-snapshot\.gpg\.key/;
  const scripts = ["scripts/sandbox-bootstrap.sh", "scripts/install-zig.sh", "Dockerfile.sandbox"];
  const fetching = [...workflows, ...actions, ...scripts].filter((path) =>
    origins.test(read(path)),
  );
  expect(fetching).toEqual(
    expect.arrayContaining([
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      ".github/workflows/llvm-dist.yml",
      ".github/actions/llvm-linux/action.yml",
      ...scripts,
    ]),
  );
  for (const path of fetching) {
    const text = read(path);
    const downloads = text.split("\n").filter((line) => origins.test(line)).length;
    const checks = text.split("verify-toolchain.sh").length - 1;
    expect(checks, `${path}: ${downloads} downloads`).toBeGreaterThanOrEqual(downloads);
    // Nothing trusts a checksum list fetched from the same place as the archive.
    expect(text, path).not.toContain("SHASUMS256.txt");
  }
  // Every LLVM archive name a workflow can download has a pin.
  const pinned = read(pinFile);
  for (const name of [
    "LLVM-22.1.8-Linux-X64.tar.xz",
    "LLVM-22.1.8-Linux-ARM64.tar.xz",
    "clang+llvm-22.1.8-x86_64-pc-windows-msvc.tar.xz",
    "llvm-project-22.1.8.src.tar.xz",
  ]) {
    expect(pinned).toContain(`  ${name}\n`);
  }
  const assets = [...read(".github/workflows/release.yml").matchAll(/llvm_asset: (\S+)/g)];
  for (const asset of assets) expect(pinned).toContain(`  ${asset[1]}.tar.xz\n`);
});

// ICU's release archives are downloaded by the pack build, not by a workflow step, and CI keeps them in a cache
// that several jobs restore. The cache is no way around the pins: its key names them, and whatever it restores
// is checked against them before it is unpacked.
test("the ICU download cache is keyed by the pins, and an archive it restores is checked", async () => {
  const icuPins = "hashFiles('packages/runtime-pack-common/scripts/icu-inputs.mjs')";
  const restores: string[] = [];
  for (const path of actions) {
    const action = load(read(path)) as {
      runs: { steps: { uses?: string; with?: { path?: string; key?: string } }[] };
    };
    for (const step of action.runs.steps) {
      if (!step.uses?.startsWith("actions/cache/restore@")) continue;
      if (!step.with?.path?.includes("scriptc-icu-")) continue;
      expect(step.with.key, path).toContain(icuPins);
      restores.push(path);
    }
  }
  expect(restores).toEqual([
    ".github/actions/icu-downloads/action.yml",
    ".github/actions/native-packages/action.yml",
  ]);

  const scripts = join(root, "packages", "runtime-pack-common", "scripts");
  const icuData = (await import(pathToFileURL(join(scripts, "icu-data.mjs")).href)) as {
    ICU_DATA_VERSION: string;
    ensureIcuSources(cacheDir: string): Promise<string>;
    ensureIcuData(cacheDir: string): Promise<string>;
  };
  const directory = mkdtempSync(join(tmpdir(), "scriptc-icu-cache-"));
  const sources = `icu4c-${icuData.ICU_DATA_VERSION}-sources.tgz`;
  const data = `icu4c-${icuData.ICU_DATA_VERSION}-data-bin-l.zip`;
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return new Response("not the archive either");
  });
  try {
    // What a restored cache could hold: files with the archives' names and other bytes.
    writeFileSync(join(directory, sources), "not the archive");
    writeFileSync(join(directory, data), "not the archive");
    const mismatch = /expected \d+ bytes with sha256 [0-9a-f]{64}/;
    await expect(icuData.ensureIcuSources(directory)).rejects.toThrow(mismatch);
    await expect(icuData.ensureIcuData(directory)).rejects.toThrow(mismatch);
    // Each reader refused the cached file and asked the release host, and refused that answer too: nothing
    // was unpacked, and the download did not replace the cached file.
    expect(requests).toBe(2);
    expect(readdirSync(directory).sort()).toEqual([data, sources].sort());
    expect(readFileSync(join(directory, sources), "utf8")).toBe("not the archive");
  } finally {
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the verifier accepts the pinned digest and rejects any other file", () => {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-toolchain-pins-"));
  try {
    const pins = join(directory, "pins.sha256");
    // sha256("hello\n")
    const digest = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
    writeFileSync(
      pins,
      `# comment\n${digest}  good.txt\n${digest}  twice.txt\n${digest}  twice.txt\nzz  bad.txt\n`,
    );
    const verify = (file: string, content: string, name?: string) => {
      writeFileSync(join(directory, file), content);
      return spawnSync(
        "sh",
        [verifier, join(directory, file), ...(name === undefined ? [] : [name])],
        {
          encoding: "utf8",
          env: { ...process.env, SCRIPTC_TOOLCHAIN_PINS: pins },
        },
      );
    };
    expect(verify("good.txt", "hello\n").status).toBe(0);
    expect(verify("download.bin", "hello\n", "good.txt").status).toBe(0);
    const tampered = verify("good.txt", "hello!\n");
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain(`pinned ${digest}`);
    const unknown = verify("other.txt", "hello\n");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("pins no SHA-256 for other.txt");
    expect(verify("twice.txt", "hello\n").status).toBe(1);
    expect(verify("bad.txt", "hello\n").status).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
