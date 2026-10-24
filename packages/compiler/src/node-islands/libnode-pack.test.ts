import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { compilerReleaseVersion } from "../library/sidecar.js";
import { NODE_BRIDGE_ABI, libnodeRecord } from "./libnode.js";
import {
  LIBNODE_PACK_SCHEMA,
  LibnodePackError,
  findInstalledLibnodePack,
  hostLibnodeTarget,
  libnodePackPackage,
  parseLibnodeSetting,
  readLibnodePack,
  writeLibnodeNotices,
} from "./libnode-pack.js";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-libnode-pack-"));
  dirs.push(dir);
  return dir;
}

function entry(bytes: string) {
  return {
    size: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** A published-style pack with stand-in libraries; `edit` adjusts the
 * manifest build-pack.mjs would write. */
function fakePack(
  dir: string,
  edit: (manifest: Record<string, unknown>) => void = () => {},
  name = "@scriptc/libnode-linux-x64-gnu",
): string {
  mkdirSync(dir, { recursive: true });
  const libnode = "stand-in libnode";
  const bridge = "stand-in bridge";
  writeFileSync(join(dir, "libnode.so.137"), libnode);
  writeFileSync(join(dir, "libscr_node_bridge.so"), bridge);
  writeFileSync(join(dir, "LICENSE"), "Node.js is licensed for use as follows:\n\nMIT\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: compilerReleaseVersion() }),
  );
  const manifest: Record<string, unknown> = {
    schema: LIBNODE_PACK_SCHEMA,
    nodeVersion: "24.22.0",
    moduleVersion: 137,
    bridgeAbi: NODE_BRIDGE_ABI,
    platform: "linux",
    arch: "x64",
    libnode: "libnode.so.137",
    bridge: "libscr_node_bridge.so",
    package: name,
    version: compilerReleaseVersion(),
    target: "linux-x64-gnu",
    license: "LICENSE",
    files: { "libnode.so.137": entry(libnode), "libscr_node_bridge.so": entry(bridge) },
  };
  edit(manifest);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

function thrown(run: () => unknown): LibnodePackError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LibnodePackError);
    return error as LibnodePackError;
  }
  throw new Error("expected a LibnodePackError");
}

describe("the pack packages", () => {
  test("every libnode platform package is the pack of one native target", () => {
    const packages = readdirSync(join(repo, "packages"))
      .filter((name) => name.startsWith("libnode-") && name !== "libnode-common")
      .map(
        (name) =>
          JSON.parse(readFileSync(join(repo, "packages", name, "package.json"), "utf8")).name,
      )
      .sort();
    const targets = ["linux-x64-gnu", "linux-arm64-gnu", "macos-arm64", "macos-x64"];
    expect(targets.map((target) => libnodePackPackage(target)).sort()).toEqual(packages);
    expect(libnodePackPackage("linux-x64-musl")).toBeNull();
    expect(libnodePackPackage("windows-x64-msvc")).toBeNull();
    expect(libnodePackPackage("wasm32-wasi")).toBeNull();
  });

  test("host targets map to native target names", () => {
    expect(hostLibnodeTarget("linux", "x64")).toBe("linux-x64-gnu");
    expect(hostLibnodeTarget("linux", "arm64")).toBe("linux-arm64-gnu");
    expect(hostLibnodeTarget("darwin", "arm64")).toBe("macos-arm64");
    expect(hostLibnodeTarget("darwin", "x64")).toBe("macos-x64");
  });
});

describe("parseLibnodeSetting", () => {
  test("accepts embedded, beside and absolute directories", () => {
    expect(parseLibnodeSetting("embedded")).toEqual({ kind: "embedded" });
    expect(parseLibnodeSetting("beside")).toEqual({ kind: "beside" });
    expect(parseLibnodeSetting("/opt/scriptc/libnode-24.22.0")).toEqual({
      kind: "path",
      path: "/opt/scriptc/libnode-24.22.0",
    });
  });

  test("rejects relative paths and other values", () => {
    expect(parseLibnodeSetting("libnode")).toBe(
      'must be "embedded", "beside" or an absolute directory, not the relative path "libnode"',
    );
    expect(parseLibnodeSetting(true)).toBe('must be "embedded", "beside" or an absolute directory');
  });
});

describe("finding the installed pack", () => {
  test("in the nearest node_modules above the project", () => {
    const root = temp();
    const pack = fakePack(join(root, "node_modules/@scriptc/libnode-linux-x64-gnu"));
    const project = join(root, "apps/web/src");
    mkdirSync(project, { recursive: true });
    expect(
      findInstalledLibnodePack({
        targetName: "linux-x64-gnu",
        projectDir: project,
        resolveInstalled: () => null,
      }),
    ).toBe(pack);
  });

  test("next to the compiler when the project has none", () => {
    const pack = fakePack(join(temp(), "libnode-darwin-arm64"));
    expect(
      findInstalledLibnodePack({
        targetName: "macos-arm64",
        projectDir: temp(),
        resolveInstalled: (name) => (name === "@scriptc/libnode-darwin-arm64" ? pack : null),
      }),
    ).toBe(pack);
    expect(
      findInstalledLibnodePack({
        targetName: "macos-arm64",
        projectDir: temp(),
        resolveInstalled: () => null,
      }),
    ).toBeNull();
  });

  test("targets without packs have none", () => {
    expect(findInstalledLibnodePack({ targetName: "linux-x64-musl", projectDir: temp() })).toBe(
      null,
    );
  });

  test("libnodeRecord uses the installed pack when nothing names one", () => {
    const root = temp();
    const name = libnodePackPackage(hostLibnodeTarget());
    if (name === null) return;
    const pack = fakePack(join(root, "node_modules", name), () => {}, name);
    expect(libnodeRecord(undefined, join(root, "app"), {}, root)).toEqual({
      libnode: pack,
      nodeVersion: "24.22.0",
    });
    // SCRIPTC_LIBNODE still wins.
    const other = fakePack(join(temp(), "other"), (m) => {
      m["nodeVersion"] = "24.13.1";
    });
    expect(libnodeRecord(undefined, join(root, "app"), { SCRIPTC_LIBNODE: other }, root)).toEqual({
      libnode: other,
      nodeVersion: "24.13.1",
    });
  });
});

test("an installed pack of another scriptc version is refused", () => {
  const root = temp();
  const name = libnodePackPackage(hostLibnodeTarget());
  if (name === null) return;
  const pack = fakePack(
    join(root, "node_modules", name),
    (m) => {
      m["version"] = "0.0.1";
    },
    name,
  );
  expect(libnodeRecord(undefined, join(root, "app"), {}, root)).toBe(
    `the installed libnode pack ${name} at ${pack} is version 0.0.1; this scriptc is ${compilerReleaseVersion()}: install ${name}@${compilerReleaseVersion()}`,
  );
});

test("an installed pack whose files do not match their digests is refused", () => {
  const root = temp();
  const name = libnodePackPackage(hostLibnodeTarget());
  if (name === null) return;
  const pack = fakePack(join(root, "node_modules", name), () => {}, name);
  // Same size, other bytes.
  writeFileSync(join(pack, "libnode.so.137"), "stand-in libnodX");
  expect(libnodeRecord(undefined, join(root, "app"), {}, root)).toBe(
    `libnode.so.137 in the libnode pack at ${pack} does not match its manifest`,
  );
});

describe("readLibnodePack", () => {
  test("reads a pack in build-pack.mjs's format and checks its package", () => {
    const pack = fakePack(join(temp(), "pack"));
    expect(
      readLibnodePack(pack, { packageName: "@scriptc/libnode-linux-x64-gnu", verifyHashes: true })
        .manifest.nodeVersion,
    ).toBe("24.22.0");
    expect(
      thrown(() => readLibnodePack(pack, { packageName: "@scriptc/libnode-linux-arm64-gnu" }))
        .message,
    ).toBe(
      `the libnode pack at ${pack} is @scriptc/libnode-linux-x64-gnu; this target needs @scriptc/libnode-linux-arm64-gnu`,
    );
  });

  test("refuses other manifest schemas and file names outside the pack", () => {
    const schema = fakePack(join(temp(), "pack"), (m) => {
      m["schema"] = "scriptc.libnode-pack.v0";
    });
    expect(thrown(() => readLibnodePack(schema)).kind).toBe("invalid");
    for (const name of [
      "lib/libnode.so.137",
      "../libnode.so.137",
      "..",
      "/etc/libnode.so",
      "a\\b",
      "a\0b",
    ]) {
      const pack = fakePack(join(temp(), "pack"), (m) => {
        m["libnode"] = name;
        m["files"] = { ...(m["files"] as object), [name]: entry("stand-in libnode") };
      });
      expect(thrown(() => readLibnodePack(pack)).message).toBe(
        `the libnode pack at ${pack} names a file outside the pack (${JSON.stringify(name)})`,
      );
    }
  });

  test("checks sizes always and hashes on request", () => {
    const pack = fakePack(join(temp(), "pack"));
    writeFileSync(join(pack, "libnode.so.137"), "stand-in libnodE");
    expect(readLibnodePack(pack).root).toBe(pack);
    expect(thrown(() => readLibnodePack(pack, { verifyHashes: true })).message).toBe(
      `libnode.so.137 in the libnode pack at ${pack} does not match its manifest`,
    );
    writeFileSync(join(pack, "libnode.so.137"), "short");
    expect(thrown(() => readLibnodePack(pack)).kind).toBe("invalid");
  });

  test("a directory without a manifest is missing", () => {
    const dir = temp();
    expect(thrown(() => readLibnodePack(dir)).message).toBe(
      `no libnode pack at ${dir} (manifest.json is missing or unreadable)`,
    );
  });
});

test("the license notices carry Node's LICENSE", () => {
  const pack = readLibnodePack(fakePack(join(temp(), "pack")));
  const out = join(temp(), "server");
  const path = writeLibnodeNotices(pack, out);
  expect(path).toBe(`${out}.licenses.txt`);
  expect(readFileSync(path, "utf8")).toBe(
    [
      `server runs part of its code in Node.js 24.22.0, loaded from libnode.so.137 (@scriptc/libnode-linux-x64-gnu@${compilerReleaseVersion()}).`,
      "Node.js and the components it bundles are licensed as follows. The scriptc bridge,",
      "libscr_node_bridge.so, is licensed under Apache-2.0.",
      "",
      "Node.js is licensed for use as follows:",
      "",
      "MIT",
      "",
    ].join("\n"),
  );
});
