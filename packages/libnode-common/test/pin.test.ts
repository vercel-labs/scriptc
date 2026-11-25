import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  LIBNODE_PLATFORMS,
  LIBNODE_PACK_SCHEMA,
  bridgeAbi,
  bridgeHash,
  configureFlagsFor,
  isReleasePackManifest,
  libnodeCacheKey,
  packFileNames,
  readPin,
  repoRoot,
  withReleasePackIdentity,
  withoutReleasePrepack,
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

  test("links the C++ runtime into Linux packs", () => {
    const pin = readPin();
    // --partly-static adds -static-libstdc++ and -static-libgcc to every
    // link in the tree, so libnode.so carries its own C++ runtime instead
    // of needing a libstdc++ newer than a supported host's.
    expect(pin.linuxConfigureFlags).toContain("--partly-static");
    expect(configureFlagsFor("linux-x64-gnu", pin)).toEqual([
      ...pin.configureFlags,
      "--partly-static",
    ]);
    expect(configureFlagsFor("linux-arm64-gnu", pin)).toEqual([
      ...pin.configureFlags,
      "--partly-static",
    ]);
    // macOS has no libstdc++ to carry.
    expect(configureFlagsFor("darwin-arm64", pin)).toEqual(pin.configureFlags);
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

describe("pack identity", () => {
  test("a release pack records its package, version and target", () => {
    expect(
      isReleasePackManifest({
        schema: LIBNODE_PACK_SCHEMA,
        package: "@scriptc/libnode-darwin-arm64",
        version: "0.1.0",
        target: "darwin-arm64",
      }),
    ).toBe(true);
  });

  test("the development fallback records no release identity", () => {
    // CI assembles this pack from dev-pack.json when the libnode build cache
    // is unavailable; it is never published, so the release-only prepack
    // verification (verify.mjs) must not run against it.
    expect(
      isReleasePackManifest({
        schema: LIBNODE_PACK_SCHEMA,
        nodeVersion: "24.22.0",
        moduleVersion: 137,
        bridgeAbi: bridgeAbi(),
        platform: "darwin",
        arch: "arm64",
        libnode: "libnode.137.dylib",
        bridge: "libscr_node_bridge.dylib",
        files: {},
      }),
    ).toBe(false);
  });

  test("packing the fallback drops only the release-only prepack", () => {
    const packageJson = {
      name: "@scriptc/libnode-darwin-arm64",
      version: "0.1.0",
      files: ["libnode.137.dylib", "manifest.json"],
      os: ["darwin"],
      cpu: ["arm64"],
      scripts: { prepack: "node ../libnode-common/scripts/verify.mjs ." },
    };
    const stripped = withoutReleasePrepack(packageJson);
    expect(stripped).toEqual({
      name: "@scriptc/libnode-darwin-arm64",
      version: "0.1.0",
      files: ["libnode.137.dylib", "manifest.json"],
      os: ["darwin"],
      cpu: ["arm64"],
      scripts: {},
    });
    // The directory being packed is a copy, but the original must not change.
    expect(packageJson.scripts.prepack).toBe("node ../libnode-common/scripts/verify.mjs .");
  });

  test("packing a package with no scripts works", () => {
    expect(withoutReleasePrepack({ name: "x" })).toEqual({ name: "x", scripts: {} });
  });

  test("packing the fallback completes the identity an installed pack is checked for", () => {
    // The build checks an installed pack's package and version
    // (packages/compiler/src/node-islands/libnode.ts). The fallback records
    // neither, so its packing copy takes the package's name and version and
    // the platform its name ends in.
    const packageJson = { name: "@scriptc/libnode-darwin-arm64", version: "0.1.0" };
    const completed = withReleasePackIdentity(
      {
        schema: LIBNODE_PACK_SCHEMA,
        nodeVersion: "24.22.0",
        moduleVersion: 137,
        bridgeAbi: bridgeAbi(),
        platform: "darwin",
        arch: "arm64",
        libnode: "libnode.137.dylib",
        bridge: "libscr_node_bridge.dylib",
        files: {},
      },
      packageJson,
    );
    expect(completed.package).toBe("@scriptc/libnode-darwin-arm64");
    expect(completed.version).toBe("0.1.0");
    expect(completed.target).toBe("darwin-arm64");
    expect(isReleasePackManifest(completed)).toBe(true);
  });

  test("a release manifest keeps the identity it records", () => {
    const manifest = {
      schema: LIBNODE_PACK_SCHEMA,
      platform: "darwin",
      arch: "arm64",
      package: "@scriptc/libnode-darwin-arm64",
      version: "0.2.0",
      target: "darwin-arm64",
    };
    expect(withReleasePackIdentity(manifest, { name: "x", version: "9.9.9" })).toEqual(manifest);
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
