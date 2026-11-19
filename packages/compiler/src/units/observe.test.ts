import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { observeUnits, type UnitsHostContext } from "./observe.js";
import type { UnitObservation } from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function observation(factValue: string, appDir = "/app"): UnitObservation {
  return {
    entry: `${appDir}/main.ts`,
    files: [
      {
        file: `${appDir}/main.ts`,
        relative: "main.ts",
        packageName: "app",
        packageVersion: "1.0.0",
        packageRoot: appDir,
        digest: (appDir === "/app" ? "1" : appDir === "/app-one" ? "4" : "5").repeat(64),
      },
      {
        file: "/app/node_modules/lib/a.ts",
        relative: "a.ts",
        packageName: "lib",
        packageVersion: "1.0.0",
        packageRoot: "/app/node_modules/lib",
        digest: "2".repeat(64),
      },
    ],
    edges: [{ from: `${appDir}/main.ts`, to: "/app/node_modules/lib/a.ts" }],
    packages: [
      {
        name: "lib",
        version: "1.0.0",
        root: "/app/node_modules/lib",
        files: [{ relative: "a.ts", digest: "2".repeat(64) }],
      },
    ],
    pins: {
      functions: [
        { module: "a.ts", name: "f" },
        { module: "main.ts", name: "main" },
      ],
    },
    lowering: {
      declarations: [
        { module: "a.ts", name: "f", kind: "function", facts: "{}" },
        { module: "main.ts", name: "main", kind: "function", facts: "{}" },
      ],
      exports: [],
      generics: { functions: [], classes: [], demands: [] },
      inits: [],
      facts: { "reads-exit-code": { value: factValue, setByOwnFiles: "unobserved" } },
    },
    classes: [],
    runtimeFeatures: {},
  };
}

function context(storeRoot: string): UnitsHostContext {
  return {
    compilerIdentity: null,
    target: "x86_64-unknown-linux-gnu",
    optimization: "dev",
    lowering: {},
    ffiDigest: null,
    environment: [],
    storeRoot,
  };
}

/** Run one observation with the `scriptc units` line swallowed. */
function observe(observationValue: UnitObservation, storeRoot: string) {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return observeUnits(observationValue, context(storeRoot));
  } finally {
    process.stderr.write = write;
  }
}

test("a second build of the same unit reports wouldHit with equal pins", () => {
  const store = mkdtempSync(join(tmpdir(), "scriptc-units-observe-"));
  roots.push(store);
  const first = observe(observation("false"), store);
  expect(first.entries.map((entry) => entry.existed)).toEqual([false, false]);
  expect(first.entries.map((entry) => entry.wouldHit)).toEqual([null, null]);

  const second = observe(observation("false"), store);
  expect(second.entries.map((entry) => entry.existed)).toEqual([true, true]);
  expect(second.entries.map((entry) => entry.wouldHit)).toEqual([true, true]);
  expect(second.entries.map((entry) => entry.pinsEqual)).toEqual([true, true]);
});

test("a changed fact value fails the pin and the unit is not reused", () => {
  const store = mkdtempSync(join(tmpdir(), "scriptc-units-observe-"));
  roots.push(store);
  observe(observation("false"), store);
  const changed = observe(observation("true"), store);
  // The dependency's files are unchanged, so its key matches and only its
  // pins differ. The app's key includes the dependency's summary digest, and
  // a program-wide fact is part of that summary, so the app's key moves too:
  // the app is a miss for a reason that is not its own.
  expect(changed.entries.map((entry) => entry.existed)).toEqual([true, false]);
  expect(changed.entries[0]!.wouldHit).toBe(false);
  expect(changed.entries[0]!.pinsEqual).toBe(false);
  expect(changed.entries[1]!.wouldHit).toBeNull();
});

test("a second app that loads the same package hits that package's unit", () => {
  const store = mkdtempSync(join(tmpdir(), "scriptc-units-observe-"));
  roots.push(store);
  observe(observation("false", "/app-one"), store);
  const second = observe(observation("false", "/app-two"), store);
  const lib = second.entries.find((entry) => entry.id === "lib@1.0.0")!;
  expect(lib.app).toBe(false);
  expect(lib.existed).toBe(true);
  expect(lib.wouldHit).toBe(true);
  expect(lib.pinsEqual).toBe(true);
  // The app itself is a different program with different files: a miss.
  const app = second.entries.find((entry) => entry.app)!;
  expect(app.existed).toBe(false);
  expect(app.wouldHit).toBeNull();
});

test("a stored entry from an older summary schema is a miss, not a guess", () => {
  const store = mkdtempSync(join(tmpdir(), "scriptc-units-observe-"));
  roots.push(store);
  const first = observe(observation("false"), store);
  const lib = first.entries.find((entry) => entry.id === "lib@1.0.0")!;
  writeFileSync(
    join(store, lib.key, "summary.json"),
    JSON.stringify({ schema: "scriptc.unit-summary.v0" }),
  );
  const second = observe(observation("false"), store);
  const again = second.entries.find((entry) => entry.id === "lib@1.0.0")!;
  expect(again.existed).toBe(true);
  expect(again.pinsEqual).toBe(false);
  expect(again.wouldHit).toBe(false);
});

test("every reached file of an app unit is in its key, not only the first", () => {
  const store = mkdtempSync(join(tmpdir(), "scriptc-units-observe-"));
  roots.push(store);
  // A second app file, whose content the second build changes.
  const withExtra = (extraDigest: string): UnitObservation => {
    const value = observation("false");
    return {
      ...value,
      files: [
        ...value.files,
        {
          file: "/app/extra.ts",
          relative: "extra.ts",
          packageName: "app",
          packageVersion: "1.0.0",
          packageRoot: "/app",
          digest: extraDigest,
        },
      ],
    };
  };
  observe(withExtra("6".repeat(64)), store);
  const changed = observe(withExtra("7".repeat(64)), store);
  const app = changed.entries.find((entry) => entry.app)!;
  // The app unit is not listed by an installed directory, so the key must
  // cover both of its reached files: editing the second one is a miss.
  expect(app.existed).toBe(false);
  expect(app.wouldHit).toBeNull();
  // The dependency's files did not change, so its entry still hits.
  const lib = changed.entries.find((entry) => entry.id === "lib@1.0.0")!;
  expect(lib.existed).toBe(true);
  expect(lib.wouldHit).toBe(true);
});
