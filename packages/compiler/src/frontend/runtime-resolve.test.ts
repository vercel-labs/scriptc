import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import {
  resolveImportMetaRuntime,
  resolveRequireRuntime,
  runtimePathForTarget,
} from "./runtime-resolve.js";
import { FrontendInputTracker, changedFrontendInput } from "./input-tracker.js";
import { FrontendServices } from "./services.js";
import { clearResolveCaches } from "./resolve.js";

test("WASI resolution metadata uses guest paths", () => {
  const source = join(process.cwd(), "tests", "program", "main.mjs");
  expect(runtimePathForTarget(source, "wasi")).toBe("/tests/program/main.mjs");
  expect(resolveImportMetaRuntime(source, "./asset with space.js", "wasi")).toEqual({
    ok: true,
    value: "file:///tests/program/asset%20with%20space.js",
  });
});

test("Windows resolution metadata uses target URL semantics on any host", () => {
  expect(resolveImportMetaRuntime("C:\\work\\main.mjs", "./asset.js", "win32")).toEqual({
    ok: true,
    value: "file:///C:/work/asset.js",
  });
});

test("runtime package resolution uses the supplied host and import conditions without evaluating code", () => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-runtime-resolve-"),
  );
  const services = new FrontendServices(() => {
    throw new Error("introspection must not open a parser connection");
  }, directory);
  try {
    const entry = join(directory, "main.mjs");
    const pkg = join(directory, "node_modules/native-resolve-fixture");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(entry, "export {};");
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "native-resolve-fixture",
        type: "module",
        exports: {
          ".": { types: "./index.d.ts", import: "./import.mjs", require: "./require.cjs" },
          "./feature": "./feature.mjs",
          "./private": null,
        },
      }),
    );
    writeFileSync(join(pkg, "index.d.ts"), "export const value: number;");
    writeFileSync(join(pkg, "import.mjs"), 'throw new Error("do not execute while resolving");');
    writeFileSync(join(pkg, "require.cjs"), 'throw new Error("wrong condition");');
    writeFileSync(join(pkg, "feature.mjs"), "export const feature = true;");
    expect(
      resolveImportMetaRuntime(entry, "native-resolve-fixture", process.platform, services),
    ).toEqual({
      ok: true,
      value: pathToFileURL(realpathSync(join(pkg, "import.mjs"))).href,
    });
    expect(
      resolveImportMetaRuntime(entry, "native-resolve-fixture/feature", process.platform, services),
    ).toEqual({
      ok: true,
      value: pathToFileURL(realpathSync(join(pkg, "feature.mjs"))).href,
    });
    const refused = resolveImportMetaRuntime(
      entry,
      "native-resolve-fixture/private",
      process.platform,
      services,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { name: "Error", code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
    });
    expect(() =>
      resolveImportMetaRuntime(entry, "native-resolve-fixture", process.platform),
    ).toThrow("requires frontend services");
  } finally {
    services.close();
    clearResolveCaches();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pure runtime URL and builtin resolution needs no process services", () => {
  const entry = join(process.cwd(), "main.mjs");
  expect(resolveImportMetaRuntime(entry, "fs", process.platform)).toEqual({
    ok: true,
    value: "node:fs",
  });
  expect(resolveImportMetaRuntime(entry, "node:fs", process.platform)).toEqual({
    ok: true,
    value: "node:fs",
  });
  expect(resolveImportMetaRuntime(entry, "https://example.com/a/../b", process.platform)).toEqual({
    ok: true,
    value: "https://example.com/b",
  });
  expect(resolveImportMetaRuntime(entry, "https://[invalid]/", process.platform)).toMatchObject({
    ok: false,
    error: { name: "TypeError", code: "ERR_INVALID_URL" },
  });
  expect(resolveImportMetaRuntime(entry, "#unimplemented", process.platform)).toBeNull();
});

test("a relative lookup path records the working directory as an input", () => {
  const entry = join(process.cwd(), "main.mjs");
  const relative = new FrontendInputTracker();
  relative.run(() => {
    resolveRequireRuntime(entry, "lookup-fixture", process.platform, ["./vendor"]);
  });
  const cwdProbe = { op: "host", path: "cwd", value: process.cwd() };
  expect(relative.snapshot().probes).toContainEqual(cwdProbe);
  expect(relative.snapshot().stable).toBe(true);
  // An absolute lookup path names its own directory, and a resolution
  // without lookup paths starts from the requesting file.
  for (const paths of [[process.cwd()], undefined]) {
    const absolute = new FrontendInputTracker();
    absolute.run(() => {
      resolveRequireRuntime(entry, "lookup-fixture", process.platform, paths);
    });
    expect(absolute.snapshot().probes).not.toContainEqual(cwdProbe);
  }
});

test("a frontend entry recorded under another working directory is not reused", () => {
  const entry = join(process.cwd(), "main.mjs");
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    resolveRequireRuntime(entry, "lookup-fixture", process.platform, ["./vendor"]);
  });
  const snapshot = tracker.snapshot();
  expect(changedFrontendInput(snapshot)).toBeNull();
  const elsewhere = {
    ...snapshot,
    probes: snapshot.probes.map((probe) =>
      probe.op === "host" && probe.path === "cwd" ? { ...probe, value: "/elsewhere" } : probe,
    ),
  };
  expect(changedFrontendInput(elsewhere)).toEqual({
    op: "host",
    path: "cwd",
    value: "/elsewhere",
  });
});
