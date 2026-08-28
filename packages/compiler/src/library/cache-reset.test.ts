import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { compileLibrary } from "../index.js";
import { STATIC_MATH_FNS } from "../frontend/lowering/surfaces.js";
import { clearFenceEvalCaches, resolveLibraryFences } from "./fence-eval.js";
import { clearSidecarCaches, compilerReleaseVersion } from "./sidecar.js";

const mockedPackage = vi.hoisted(() => ({ version: null as string | null }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      if (mockedPackage.version !== null && /[\\/]packages[\\/]compiler[\\/]package\.json$/.test(String(path))) {
        return JSON.stringify({ version: mockedPackage.version });
      }
      return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
    },
  };
});

const randomSurface = STATIC_MATH_FNS.random;

afterEach(() => {
  mockedPackage.version = null;
  STATIC_MATH_FNS.random = randomSurface;
  clearSidecarCaches();
  clearFenceEvalCaches();
});

test("compileLibrary refreshes release identity and fence taxonomy before profile loading", async () => {
  const firstVersion = compilerReleaseVersion();
  const changedVersion = `${firstVersion}-cache-reset-test`;
  mockedPackage.version = changedVersion;

  const fence = [{ path: "test[0]", id: "stdlib.math.random" }];
  expect(resolveLibraryFences(fence).ok).toBe(true);
  // Mutate one taxonomy source after the old view has been memoized. The
  // profile load below must rebuild it before resolving this static fence.
  delete STATIC_MATH_FNS.random;

  const result = await compileLibrary({
    profilePath: join(import.meta.dirname, "cache-reset-fixtures", "profile.json"),
    outDir: join(import.meta.dirname, "cache-reset-fixtures", "out"),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.diagnostics[0]?.code).toBe("SC4001");
  expect(result.diagnostics[0]?.message).toContain("names no entry");
  expect(compilerReleaseVersion()).toBe(changedVersion);
});
