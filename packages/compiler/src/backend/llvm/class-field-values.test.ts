import { expect, test } from "vitest";
import { BOOL, DYN, F64, UNDEFINED_T, type IrModule, type IrType } from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { LlEmitter } from "./emitter.js";

test.each([32, 64] as const)(
  "class field boxing preserves bool, inline and nullable storage on %s-bit targets",
  (pointerBits) => {
    const loc = { file: "class-fields.ts", start: 0, end: 0 };
    const type: IrType = { kind: "object", className: "Mixed" };
    const keys: IrType = { kind: "set", elem: { kind: "union", unionId: "boxedChild" } };
    const source: IrModule = {
      irVersion: 17,
      sourceFile: loc.file,
      entry: "main",
      classes: [
        { name: "Child", fields: [{ name: "value", type: F64 }], loc },
        {
          name: "Mixed",
          fields: [
            { name: "flag", type: BOOL },
            { name: "scalar", type: { kind: "union", unionId: "scalar" } },
            { name: "child", type: { kind: "union", unionId: "child" } },
            { name: "boxedChild", type: { kind: "union", unionId: "boxedChild" } },
          ],
          loc,
        },
      ],
      unions: [
        { id: "scalar", arms: [F64, UNDEFINED_T] },
        { id: "child", arms: [{ kind: "object", className: "Child" }, UNDEFINED_T] },
        { id: "boxedChild", arms: [{ kind: "object", className: "Child" }, UNDEFINED_T] },
      ],
      functions: [
        {
          name: "main",
          params: [
            { localId: "item", name: "item", type },
            { localId: "keys", name: "keys", type: keys },
          ],
          locals: [
            { id: "item", name: "item", type, mutable: false },
            { id: "keys", name: "keys", type: keys, mutable: false },
          ],
          returnType: DYN,
          body: [
            {
              kind: "return",
              value: {
                kind: "dynFrom",
                value: { kind: "varRef", localId: "item", type, loc },
                type: DYN,
                loc,
              },
              loc,
            },
          ],
          loc,
        },
      ],
    };
    expect(validateModule(source)).toEqual([]);
    const emitter = new LlEmitter(source, { pointerBits });
    // Set keys require tagged union values, but the class field still
    // stores a nullable pointer. The ordinary child union stays unboxed.
    expect(emitter.nullableUnions.has("child")).toBe(true);
    expect(emitter.nullableUnions.has("boxedChild")).toBe(false);
    expect(emitter.nullableFields.get("Mixed", "boxedChild")).not.toBeNull();
    const adapter = emitter.liveDynRefAdapter(type);
    const llvm = emitter.emitParts().join("\n");
    const body = llvm.match(
      new RegExp(`^define internal ptr @${adapter.snapshot}\\(.*?^}`, "ms"),
    )![0];
    expect(body).toMatch(/load i8, ptr/);
    expect(body).toMatch(/trunc i8 %\w+ to i1/);
    expect(body).toContain("getelementptr inbounds { i32, i64 }");
    expect(body).toMatch(/icmp eq ptr %\w+, null/);
    expect(body).toContain("@scr_union_new_ref");
    // Only the nullable reference creates an owned wrapper. Inline union
    // fields lend an immortal stack box and must not gain a heap release.
    expect(body.match(/call void @scr_union_release\(/g)).toHaveLength(1);
    expect(body).not.toContain("@scr_dyn_typed_ref_materialize");
  },
);
