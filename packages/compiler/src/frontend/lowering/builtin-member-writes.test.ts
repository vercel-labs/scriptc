import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUILTIN_OBJECT_INHERITS,
  BUILTIN_OBJECT_MEMBERS,
} from "./builtin-object-members.generated.js";
import { builtinMemberKind, builtinOwnMemberKind } from "./builtin-member-writes.js";

const repoRoot = join(import.meta.dirname, "../../../../..");

describe("built-in object member census", () => {
  test("is what the pinned Node release answers", () => {
    // The generator refuses to run under any other release, so the check is
    // meaningful only there; CI and the Sandbox lanes run the pinned one.
    execFileSync(process.execPath, ["scripts/gen-builtin-object-members.mjs", "--check"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  });

  test("names every member once, behind a kind letter", () => {
    for (const [owner, row] of Object.entries(BUILTIN_OBJECT_MEMBERS)) {
      const names = row.split(" ").filter((item) => item !== "");
      for (const item of names) expect(item, owner).toMatch(/^[fatz]-?=?[^-=]/);
      const bare = names.map((item) => item.replace(/^.-?=?/, ""));
      expect(new Set(bare).size, owner).toBe(names.length);
    }
  });

  test("links every inheriting object to an object of the census", () => {
    for (const [owner, parent] of Object.entries(BUILTIN_OBJECT_INHERITS)) {
      expect(BUILTIN_OBJECT_MEMBERS[owner], owner).toBeDefined();
      expect(BUILTIN_OBJECT_MEMBERS[parent], parent).toBeDefined();
    }
  });

  test("answers own members by kind", () => {
    expect(builtinOwnMemberKind("Array.prototype", "push")).toBe("f");
    expect(builtinOwnMemberKind("Array.prototype", "@@iterator")).toBe("f");
    expect(builtinOwnMemberKind("Array.prototype", "length")).toBe("z");
    expect(builtinOwnMemberKind("Map.prototype", "size")).toBe("a");
    expect(builtinOwnMemberKind("Math", "PI")).toBe("t");
    expect(builtinOwnMemberKind("Math", "random")).toBe("f");
    expect(builtinOwnMemberKind("globalThis", "Array")).toBe("f");
    expect(builtinOwnMemberKind("globalThis", "console")).toBeNull();
    expect(builtinOwnMemberKind("Function.prototype", "call")).toBe("f");
  });

  test("answers null for a member the object does not have", () => {
    expect(builtinOwnMemberKind("Array.prototype", "lastItem")).toBeNull();
    expect(builtinMemberKind("Array.prototype", "lastItem")).toBeNull();
    expect(builtinMemberKind("Math", "twice")).toBeNull();
    expect(builtinMemberKind("NotAnObject", "push")).toBeNull();
  });

  test("finds a member inherited from another built-in object", () => {
    // A typed array's methods live on the intrinsic no global names.
    expect(builtinOwnMemberKind("Uint8Array.prototype", "fill")).toBeNull();
    expect(builtinMemberKind("Uint8Array.prototype", "fill")).toBe("f");
    expect(builtinMemberKind("TypeError.prototype", "toString")).toBe("f");
    expect(builtinMemberKind("Map.prototype", "hasOwnProperty")).toBe("f");
    expect(builtinMemberKind("Array", "bind")).toBe("f");
  });
});
