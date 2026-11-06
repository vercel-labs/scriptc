/* The function-value derivation (wave-2 decision 5 = A): a builtin table row
 * whose direct-call lowering is the generic table tail derives its value
 * shape from its own ABI, so `fsp.stat` is a closure `fsp.stat(path)` is.
 * The decisions here are the two sets the derivation reads, so the tests pin
 * them against the table: the shape-validated members must be real members,
 * and every row the derivation accepts must produce the adapter a direct
 * call with those arguments compiles to. */
import { describe, expect, test } from "vitest";
import { BUILTIN_MODULE_MEMBERS } from "../builtin-module-members.generated.js";
import { DYN, STATS_T } from "../../../ir/ir.js";
import { builtinModuleFns, type BuiltinModuleFn } from "../surfaces.js";
import {
  CALL_SHAPE_MEMBERS,
  DERIVED_VALUE_MODULES,
  derivedBuiltinValueFn,
} from "./module-call-values.js";

/** Members the lowering answers before the module table: graceful-fs's
 * gracefulify(fsModule) is a no-op statement (builtin-calls.ts), not a Node
 * export, so it is neither in the census nor in the table. */
const PRE_TABLE_MEMBERS: ReadonlySet<string> = new Set(["fs.gracefulify"]);

function row(module: string, member: string): BuiltinModuleFn {
  const fn = builtinModuleFns()[module]?.[member];
  if (!fn) throw new Error(`${module}.${member} has no table row`);
  return fn;
}

function derive(module: string, member: string): BuiltinModuleFn | null {
  const fn = builtinModuleFns()[module]?.[member];
  return fn ? derivedBuiltinValueFn({ module, member }, fn) : null;
}

describe("builtin function-value derivation", () => {
  test("every shape-validated module derives values", () => {
    // A shape list for a module outside DERIVED_VALUE_MODULES would be dead:
    // the module check answers first.
    for (const module of Object.keys(CALL_SHAPE_MEMBERS))
      expect(DERIVED_VALUE_MODULES.has(module), module).toBe(true);
  });

  test("every shape-validated member names something real", () => {
    // The census is Node's own export list and the table is what the
    // lowering dispatches, so a renamed or removed member fails here instead
    // of silently losing its exclusion. A few names are neither (Node no
    // longer exports fs.gracefulify), which the table row covers.
    for (const [module, members] of Object.entries(CALL_SHAPE_MEMBERS)) {
      const ownNames = BUILTIN_MODULE_MEMBERS[module]?.ownNames ?? [];
      for (const member of members)
        expect(
          ownNames.includes(member) ||
            builtinModuleFns()[module]?.[member] !== undefined ||
            PRE_TABLE_MEMBERS.has(`${module}.${member}`),
          `${module}.${member}`,
        ).toBe(true);
    }
  });

  test("a shape-validated row keeps the by-name refusal", () => {
    // The call site validates these (realpath's utf8-only read, the statSync
    // Dirent option, setPriority's one-argument completion); a value would
    // bypass that validation.
    for (const [module, members] of Object.entries(CALL_SHAPE_MEMBERS))
      for (const member of members)
        if (builtinModuleFns()[module]?.[member])
          expect(derivedBuiltinValueFn({ module, member }, row(module, member))).toBeNull();
  });

  test("derives the adapter a direct call of those arguments compiles to", () => {
    // fs/promises.stat's direct call is fsp.stat(path) generically, so the
    // value takes exactly one string and settles a Stats.
    const stat = derive("fs/promises", "stat");
    expect(stat).not.toBeNull();
    expect(stat?.fn).toBe("fsp.stat");
    expect(stat?.params).toEqual([{ kind: "string" }]);
    expect(stat?.result).toEqual({ kind: "promise", inner: STATS_T });
    expect(stat?.valueParams).toEqual([{ mode: "required", type: { kind: "string" } }]);
    expect(stat?.valueFn).toBeUndefined();
    expect(stat?.checked).toBeUndefined();

    // fs.mkdtempSync's row is its ABI: one prefix. Its call-site fence is
    // the sync/async family's, not an argument shape, so it derives.
    expect(derive("fs", "mkdtempSync")?.valueParams).toEqual([
      { mode: "required", type: { kind: "string" } },
    ]);
    expect(derive("fs", "rmdirSync")?.result).toEqual({ kind: "void" });
    expect(derive("fs/promises", "mkdtemp")?.valueParams).toEqual([
      { mode: "required", type: { kind: "string" } },
    ]);
    expect(derive("fs/promises", "rmdir")?.result).toEqual({
      kind: "promise",
      inner: { kind: "void" },
    });
  });

  test("does not mutate the table row it derives from", () => {
    const before = row("fs/promises", "lstat");
    derive("fs/promises", "lstat");
    expect(row("fs/promises", "lstat")).toBe(before);
    expect(before.valueParams).toBeUndefined();
  });

  test("a row with an explicit contract is not re-derived", () => {
    // unlink/chmod/rename state their value signature; the derivation must
    // leave them alone so one representation decides the adapter.
    for (const [module, member] of [
      ["fs/promises", "unlink"],
      ["fs/promises", "rename"],
      ["fs/promises", "readlink"],
      ["os", "homedir"],
      ["fs/promises", "cp"],
    ] as const)
      expect(derive(module, member), `${module}.${member}`).toBeNull();
  });

  test("a shape a source-level function type cannot spell is refused", () => {
    // A rest pack (path.join), a callback dispatcher (fs.read), a dynamic
    // parameter (fsp.glob) or a dynamic result has no typed slot to lower.
    expect(derive("path", "join")).toBeNull();
    // fs.read's table entry is synthesized by builtinModuleFnOf; a callback
    // dispatcher row is the same refusal however it arrives.
    expect(
      derivedBuiltinValueFn(
        { module: "fs", member: "read" },
        { fn: "fs.callbackCall", params: [], result: DYN },
      ),
    ).toBeNull();
    expect(derive("fs/promises", "glob")).toBeNull();
    // A module whose call lowering lives in its own dispatcher: its row can
    // stand for a shape-specific entry point this derivation does not see.
    expect(derive("crypto", "createHash")).toBeNull();
    expect(derive("zlib", "deflateSync")).toBeNull();
  });

  test("a plain row of a derived module derives whatever its ABI is", () => {
    // No member list: the derivation follows the table, so a new row of a
    // derived module becomes a value without another entry.
    expect(derive("fs/promises", "rmdir")?.valueParams).toEqual([
      { mode: "required", type: { kind: "string" } },
    ]);
  });
});
