import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { islandBuildHost, setIslandBuildHost } from "./node-islands/host.js";
import { libnodeCacheKey, libnodeTarget } from "./node-islands/libnode.js";
import { libnodePackPackage } from "./node-islands/libnode-pack.js";

// A libnode pack installed beside the compiler, not in the project: what
// Node's resolution from the compiler answers for its package.
const beside = mkdtempSync(join(tmpdir(), "scriptc-startup-libnode-"));
mkdirSync(beside, { recursive: true });
writeFileSync(join(beside, "manifest.json"), JSON.stringify({ nodeVersion: "24.22.0" }));
const packName = libnodePackPackage(libnodeTarget({}));
vi.mock("./node-islands/compiler-package-node.js", () => ({
  nodeCompilerPackage: (name: string) => (name === packName ? beside : null),
}));

const startup = await import("./startup-cache.js");
const { nodeCompilerPackage } = await import("./node-islands/compiler-package-node.js");

const installed = islandBuildHost();
afterEach(() => setIslandBuildHost(installed));

test("CLI startup names the libnode pack beside the compiler as the build does", () => {
  if (packName === null) return;
  const project = mkdtempSync(join(tmpdir(), "scriptc-startup-project-"));
  // Startup runs before any island build host is installed.
  setIslandBuildHost({ compilerPackage: () => null, runtimeSources: () => null });
  const atStartup = startup.libnodeCacheKey(undefined, {}, project);
  expect(atStartup).toContain(`|${beside}|`);
  // The full compiler's build records the identity with the host installed
  // (host-node.ts), which answers with the same resolution.
  setIslandBuildHost({ compilerPackage: nodeCompilerPackage, runtimeSources: () => null });
  expect(libnodeCacheKey(undefined, {}, project)).toBe(atStartup);
});
