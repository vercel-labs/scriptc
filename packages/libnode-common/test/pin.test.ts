import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  LIBNODE_PLATFORMS,
  bridgeAbi,
  bridgeHash,
  libnodeCacheKey,
  packFileNames,
  readPin,
  repoRoot,
} from "../scripts/pin.mjs";
import { expectedTranscript } from "../scripts/smoke.mjs";

const readJson = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

describe("the libnode pin", () => {
  test("is the repository's pinned Node release", () => {
    const pin = readPin();
    expect(pin.nodeVersion).toBe(readJson("internal/compatibility/node-v24.json").version);
    expect(pin.nodeVersion).toBe(readFileSync(join(repoRoot, ".node-version"), "utf8").trim());
    expect(pin.tarballSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("builds the shared library with full ICU (design §8 question 2)", () => {
    const pin = readPin();
    expect(pin.configureFlags).toContain("--shared");
    expect(pin.configureFlags.some((flag: string) => flag.startsWith("--with-intl"))).toBe(false);
    expect(pin.icu).toBe("full");
  });
});

describe("the platform packages", () => {
  const dirs = readdirSync(join(repoRoot, "packages")).filter(
    (name) => name.startsWith("libnode-") && name !== "libnode-common",
  );

  test("match the platform table", () => {
    expect(dirs.map((dir) => dir.slice("libnode-".length)).sort()).toEqual(
      Object.keys(LIBNODE_PLATFORMS).sort(),
    );
  });

  test.each(Object.entries(LIBNODE_PLATFORMS))("%s ships its libraries", (platform, info) => {
    const manifest = readJson(`packages/libnode-${platform}/package.json`);
    const names = packFileNames(platform, readPin().moduleVersion);
    expect(manifest.name).toBe(`@scriptc/libnode-${platform}`);
    expect(manifest.version).toBe(readJson("packages/cli/package.json").version);
    expect(manifest.os).toEqual([info.os]);
    expect(manifest.cpu).toEqual([info.arch]);
    expect(manifest.files).toEqual([
      names.libnode,
      names.bridge,
      "manifest.json",
      "LICENSE",
      "SCRIPTC_LICENSE",
      "THIRD_PARTY_NOTICES",
    ]);
    // Never built by `pnpm -r build`.
    expect(manifest.scripts.build).toBe("true");
    expect(manifest.scripts["build:native"]).toBe("node scripts/build.mjs");
  });
});

describe("cache identity", () => {
  test("the libnode key depends on platform and toolchain, not on the bridge", () => {
    const a = libnodeCacheKey("linux-x64-gnu", "manylinux_2_28-gcc-toolset-14");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(libnodeCacheKey("linux-x64-gnu", "manylinux_2_28-gcc-toolset-14")).toBe(a);
    expect(libnodeCacheKey("linux-arm64-gnu", "manylinux_2_28-gcc-toolset-14")).not.toBe(a);
    expect(libnodeCacheKey("linux-x64-gnu", "other")).not.toBe(a);
    expect(bridgeHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("unknown platforms are refused", () => {
    expect(() => libnodeCacheKey("linux-x64-musl", "x")).toThrow(
      "unknown libnode pack platform linux-x64-musl",
    );
  });
});

test("the smoke transcript pins the Node version, the snapshot and full ICU", () => {
  const lines = expectedTranscript().split("\n");
  expect(lines[0]).toBe(
    `bridge ABI ${bridgeAbi()}, Node ${readPin().nodeVersion}, NODE_MODULE_VERSION ${readPin().moduleVersion}`,
  );
  expect(lines).toContain("process.config.variables.node_use_node_snapshot => Rtrue");
  expect(lines).toContain(`new Intl.NumberFormat('de-DE').format(1234567.891) => R"1.234.567,891"`);
  expect(lines.at(-2)).toBe("ok");
});
