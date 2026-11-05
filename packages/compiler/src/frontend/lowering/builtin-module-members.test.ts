import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SUPPORTED_BUILTIN_MODULES } from "../builtin-modules.js";
import { BUILTIN_MODULE_MEMBERS } from "./builtin-module-members.generated.js";
import {
  builtinModuleHasMember,
  builtinModuleHasOwnMember,
  builtinModuleKeys,
} from "./builtin-module-members.js";

describe("builtin module member census", () => {
  test("has a row for every supported builtin module", () => {
    expect(Object.keys(BUILTIN_MODULE_MEMBERS).sort()).toEqual(
      [...SUPPORTED_BUILTIN_MODULES].sort(),
    );
  });

  test("lists own enumerable keys inside the own-name set", () => {
    for (const [module, census] of Object.entries(BUILTIN_MODULE_MEMBERS)) {
      for (const key of census.keys) expect(census.ownNames, module).toContain(key);
      expect(new Set(census.keys).size, module).toBe(census.keys.length);
      expect(new Set(census.ownNames).size, module).toBe(census.ownNames.length);
    }
  });

  test("answers the CommonJS and ESM namespace shapes", () => {
    // zlib's CommonJS exports object answers the prototype chain; its ESM
    // namespace object answers only the export names, sorted, plus
    // "default".
    expect(builtinModuleHasMember("zlib", "cjs", "toString")).toBe(true);
    expect(builtinModuleHasMember("zlib", "esm", "toString")).toBe(false);
    expect(builtinModuleHasOwnMember("zlib", "cjs", "toString")).toBe(false);
    expect(builtinModuleHasOwnMember("zlib", "cjs", "deflateSync")).toBe(true);
    expect(builtinModuleKeys("zlib", "esm")).toContain("default");
    const sorted = [...(builtinModuleKeys("zlib", "esm") ?? [])];
    expect(sorted).toEqual(sorted.sort());
    // node:events exports a callable CommonJS value; its ESM namespace is
    // an ordinary object.
    expect(BUILTIN_MODULE_MEMBERS.events?.callable).toBe(true);
    expect(BUILTIN_MODULE_MEMBERS.path?.callable).toBe(false);
  });

  test("answers null for a module outside the census", () => {
    expect(builtinModuleHasMember("not-a-module", "cjs", "x")).toBeNull();
    expect(builtinModuleHasOwnMember("not-a-module", "esm", "x")).toBeNull();
    expect(builtinModuleKeys("not-a-module", "cjs")).toBeNull();
  });
});

// The census is generated from the repository's pinned Node, so freshness
// is checked only where that is the running Node.
const pinned = readFileSync(
  new URL("../../../../../.node-version", import.meta.url),
  "utf8",
).trim();

test.skipIf(process.version !== `v${pinned}`)("census is current", () => {
  const script = new URL("../../../../../scripts/gen-builtin-module-members.mjs", import.meta.url);
  expect(() =>
    execFileSync(process.execPath, [script.pathname, "--check"], { stdio: "pipe" }),
  ).not.toThrow();
});
