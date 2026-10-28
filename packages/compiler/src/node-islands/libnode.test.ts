import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { USES_TIMERS_LIB_FNS } from "../backend/llvm/lib-shared.js";
import { libnodeCacheKey, libnodeRecord, NODE_BRIDGE_ABI } from "./libnode.js";

function pack(nodeVersion: string, bridgeAbi = NODE_BRIDGE_ABI): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-libnode-"));
  writeFileSync(join(dir, "libnode.so.137"), "lib");
  writeFileSync(join(dir, "libscr_node_bridge.so"), "bridge");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      nodeVersion,
      bridgeAbi,
      files: { "libnode.so.137": {}, "libscr_node_bridge.so": {} },
    }),
  );
  return dir;
}

describe("the recorded libnode pack", () => {
  test("records the pack directory and its exact Node version", () => {
    const dir = pack("24.22.0");
    expect(libnodeRecord(dir, "/out/app", {})).toEqual({ libnode: dir, nodeVersion: "24.22.0" });
    expect(libnodeRecord(undefined, "/out/app", { SCRIPTC_LIBNODE: dir })).toEqual({
      libnode: dir,
      nodeVersion: "24.22.0",
    });
  });

  test("refuses a missing, too old or incompatible pack", () => {
    expect(libnodeRecord(undefined, "/out/app", {})).toMatch(/no libnode pack is installed/);
    expect(libnodeRecord("/nonexistent", "/out/app", {})).toBe(
      "no libnode pack at /nonexistent (manifest.json is missing or unreadable)",
    );
    expect(libnodeRecord(pack("24.12.0"), "/out/app", {})).toMatch(
      /is Node 24\.12\.0; Node islands need Node\.js >=24\.13\.1$/,
    );
    expect(libnodeRecord(pack("24.22.0", 99), "/out/app", {})).toMatch(/has bridge ABI 99/);
    expect(libnodeRecord("relative/pack", "/out/app", {})).toBe(
      "the libnode pack directory must be absolute, got 'relative/pack'",
    );
  });

  test("beside copies the pack next to the executable and records it relative to it", () => {
    const dir = pack("24.22.0");
    const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
    mkdirSync(out, { recursive: true });
    expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir })).toEqual({
      libnode: "$ORIGIN/app.libnode",
      nodeVersion: "24.22.0",
    });
    expect(readFileSync(join(out, "app.libnode/libscr_node_bridge.so"), "utf8")).toBe("bridge");
    expect(existsSync(join(out, "app.libnode/manifest.json"))).toBe(true);
  });

  test("beside places the pack again after the outputs were deleted", () => {
    // A cached executable restored without its pack gets it again (compile, index.ts).
    const dir = pack("24.22.0");
    const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
    libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir });
    rmSync(join(out, "app.libnode"), { recursive: true, force: true });
    expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir })).toEqual({
      libnode: "$ORIGIN/app.libnode",
      nodeVersion: "24.22.0",
    });
    expect(readFileSync(join(out, "app.libnode/libscr_node_bridge.so"), "utf8")).toBe("bridge");
  });

  test("beside refuses to replace the pack it copies", () => {
    const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
    const first = pack("24.22.0");
    libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: first });
    // The placed copy as the source of the next beside build.
    const placed = join(out, "app.libnode");
    expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: placed })).toMatch(
      /^--libnode=beside would replace the libnode pack it copies/,
    );
    expect(readFileSync(join(placed, "libscr_node_bridge.so"), "utf8")).toBe("bridge");
  });

  test("beside refuses manifest file names outside the pack", () => {
    const dir = pack("24.22.0");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ nodeVersion: "24.22.0", bridgeAbi: NODE_BRIDGE_ABI, files: { "../x": {} } }),
    );
    const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
    expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir })).toBe(
      `the libnode pack at ${dir} lists a file outside the pack ('../x')`,
    );
    expect(existsSync(join(out, "app.libnode"))).toBe(false);
  });

  test("beside refuses manifest file names outside the pack", () => {
    for (const name of ["..", ".", "../escaped", "/etc/passwd", "a/b", "a\\b", "x\u0000y"]) {
      const dir = pack("24.22.0");
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
          nodeVersion: "24.22.0",
          bridgeAbi: NODE_BRIDGE_ABI,
          files: { [name]: {} },
        }),
      );
      const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
      expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir })).toBe(
        `the libnode pack at ${dir} lists a file outside the pack ('${name}')`,
      );
      expect(existsSync(join(out, "app.libnode"))).toBe(false);
      expect(existsSync(join(out, "escaped"))).toBe(false);
    }
  });

  test("beside refuses pack files that are symbolic links", () => {
    const dir = pack("24.22.0");
    const elsewhere = join(mkdtempSync(join(tmpdir(), "scriptc-libnode-elsewhere-")), "secret");
    writeFileSync(elsewhere, "secret");
    rmSync(join(dir, "libnode.so.137"));
    symlinkSync(elsewhere, join(dir, "libnode.so.137"));
    const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
    expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir })).toBe(
      `the libnode pack at ${dir} holds libnode.so.137 as a symbolic link; pack files must be regular files`,
    );
    expect(existsSync(join(out, "app.libnode"))).toBe(false);
  });

  test("a pack the deployment places beside the executable needs no manifest at build time", () => {
    expect(libnodeRecord("$ORIGIN/node", "/out/app", {})).toEqual({
      libnode: "$ORIGIN/node",
      nodeVersion: "",
    });
  });
});

describe("the libnode pack in an executable's cache key", () => {
  test("is absent without --libnode or SCRIPTC_LIBNODE", () => {
    expect(libnodeCacheKey(undefined, {})).toBeUndefined();
  });

  test("changes when the pack in the same directory is upgraded", () => {
    const dir = pack("24.22.0");
    const before = libnodeCacheKey(dir, {});
    expect(libnodeCacheKey(dir, {})).toBe(before);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ nodeVersion: "24.23.0", bridgeAbi: NODE_BRIDGE_ABI, files: {} }),
    );
    expect(libnodeCacheKey(dir, {})).not.toBe(before);
  });

  test("names the pack beside copies from", () => {
    const a = pack("24.22.0");
    const b = pack("24.22.0");
    expect(libnodeCacheKey("beside", { SCRIPTC_LIBNODE: a })).not.toBe(
      libnodeCacheKey("beside", { SCRIPTC_LIBNODE: b }),
    );
    expect(libnodeCacheKey("beside", { SCRIPTC_LIBNODE: a })).not.toBe(libnodeCacheKey(a, {}));
  });
});

test("calls into Node keep the program's event loop running", () => {
  // Node's ref'd timers and I/O run on the program's loop (scr_node_island.c).
  expect(USES_TIMERS_LIB_FNS.has("nodeIsland.call")).toBe(true);
  expect(USES_TIMERS_LIB_FNS.has("nodeIsland.callSync")).toBe(true);
});
