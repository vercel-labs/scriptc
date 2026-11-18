import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { BOOL, DYN, F64, STRING, type IrType } from "../../ir/ir.js";
import { RUNTIME_ERROR_PREFIX_FIELDS } from "./lower-classes.js";

/** The field categories the C struct and the IR layout must agree on, in
 * order: a bool, a double, or a pointer (every string, dyn and object slot). */
function category(t: IrType): string {
  if (t === BOOL) return "bool";
  if (t === F64) return "double";
  if (t === STRING || t === DYN) return "pointer";
  throw new Error(`unexpected error-prefix field type ${JSON.stringify(t)}`);
}

function cCategory(type: string): string {
  if (type === "bool") return "bool";
  if (type === "double" || type === "float") return "double";
  return "pointer";
}

/** scr_error.h's `ScrError` fields, in declaration order. */
function headerFields(): { name: string; type: string }[] {
  const path = fileURLToPath(new URL("../../../../runtime/src/scr_error.h", import.meta.url));
  const header = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = header.indexOf("typedef struct ScrError {");
  if (start < 0) throw new Error("scr_error.h no longer defines `typedef struct ScrError`");
  const end = header.indexOf("} ScrError;", start);
  if (end < 0) throw new Error("scr_error.h's ScrError has no closing brace");
  return header
    .slice(header.indexOf("{", start) + 1, end)
    .split(";")
    .map((decl) => decl.trim())
    .filter((decl) => decl.length > 0)
    .map((decl) => {
      const m = /^(.*?)\s*\b([A-Za-z_]\w*)$/.exec(decl);
      if (!m) throw new Error(`cannot parse ScrError field ${JSON.stringify(decl)}`);
      return { name: m[2]!, type: m[1]!.replace(/\*+$/, "").trim() };
    });
}

/* A user class extending Error lays its own fields out right after
 * ScrError, so this list is a struct-offset contract, not a comment: a
 * header field the compiler does not know hands its bytes to the subclass's
 * first field (a `bool` field there set a DNSException's `errno` slot).
 * Adding, removing, reordering or retyping a header field must change the
 * lowering's list in the same commit. */
test("the compiler's error prefix mirrors scr_error.h field for field", () => {
  // `rc` and `vt` are the header the compiler's class struct spells itself.
  const fields = headerFields().slice(2);
  expect(fields.length).toBeGreaterThan(10);
  expect(fields.map((f) => cCategory(f.type))).toEqual(
    RUNTIME_ERROR_PREFIX_FIELDS.map((f) => category(f.type)),
  );
});
