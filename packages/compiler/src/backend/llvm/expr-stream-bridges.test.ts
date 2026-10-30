import { expect, test } from "vitest";
import {
  DYN,
  DYN_CLASS_PROPERTIES,
  BOOL,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  canBoxFuncIntoDyn,
  canDynCheckTo,
  funcOf,
  type IrFunction,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule, LlEmitter } from "./emitter.js";

function sharedGraph(roots: number): IrModule {
  const loc = { file: "live-references.ts", start: 0, end: 0 };
  const leaf: IrType = { kind: "record", shapeId: "leaf" };
  const root: IrType = { kind: "record", shapeId: "root" };
  const next: IrType = { kind: "union", unionId: "next" };
  const inputs: (IrType & { kind: "union" })[] = Array.from({ length: roots }, (_, index) => ({
    kind: "union",
    unionId: `input${index}`,
  }));
  return {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    records: [
      {
        id: "leaf",
        fields: [
          { name: "name", type: STRING },
          { name: "next", type: next },
          { name: "children", type: { kind: "array", elem: leaf } },
        ],
      },
      {
        id: "root",
        fields: [
          { name: "first", type: leaf },
          { name: "second", type: leaf },
        ],
      },
    ],
    unions: [
      { id: "next", arms: [leaf, UNDEFINED_T] },
      ...inputs.map((type) => ({
        id: type.unionId,
        arms: [root, leaf, STRING],
      })),
    ],
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      ...inputs.map((type, index): IrFunction => ({
        name: `box${index}`,
        params: [{ name: "value", localId: "value", type }],
        returnType: DYN,
        locals: [{ id: "value", name: "value", type, mutable: false }],
        loc,
        body: [
          {
            kind: "return" as const,
            value: {
              kind: "dynFrom" as const,
              value: { kind: "varRef" as const, localId: "value", type, loc },
              liveRef: true,
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      })),
    ],
  };
}

test("native callback extraction does not generate an unsupported typed-rest adapter", () => {
  for (const pointerBits of [32, 64] as const) {
    for (const typedRest of [false, true]) {
      const module = sharedGraph(0);
      const callback: IrType & { kind: "func" } = typedRest
        ? {
            kind: "func",
            params: [{ kind: "array", elem: STRING }],
            ret: STRING,
            rest: true,
            restAbi: "typed",
          }
        : { kind: "func", params: [STRING], ret: STRING };
      const getRecord = (id: string) => module.records!.find((record) => record.id === id);
      const getUnion = (id: string) => module.unions!.find((union) => union.id === id);
      expect(canBoxFuncIntoDyn(callback, getRecord, getUnion)).toBe(true);
      // Internal exact extraction does not broaden the public cast domain.
      expect(canDynCheckTo(callback, getRecord, getUnion)).toBe(!typedRest);
      const emitter = new LlEmitter(module, { pointerBits });
      const checked = emitter.dyn.dynCheckHelper(callback);
      const boxed = emitter.dyn.dynFuncBoxHelper(callback);
      expect(emitter.dyn.dynCheckHelper(callback)).toBe(checked);
      expect(emitter.dyn.dynFuncBoxHelper(callback)).toBe(boxed);
      const llvm = emitter.emitParts().join("\n");
      const body = llvm.match(new RegExp(`^define internal ptr @${checked}\\(.*?^}`, "ms"))?.[0];
      expect(body).toBeDefined();
      expect(body).toContain("call ptr @scr_dyn_func_unbox_exact(");
      expect(llvm).toContain("call ptr @scr_dyn_new_func(");
      expect(llvm.includes("define internal ptr @sc_dfa_")).toBe(!typedRest);
      if (typedRest) {
        expect(body).not.toContain("@scr_closure_new(");
        expect(body).toContain("call void @scr_dyn_check_fail(");
      }
    }
  }
});

test("live array exposure installs exact slot codecs and cleans up failed recursive binding", () => {
  for (const pointerBits of [32, 64] as const) {
    const module = sharedGraph(2);
    const emitter = new LlEmitter(module, { pointerBits });
    const recursive: IrType = { kind: "array", elem: { kind: "record", shapeId: "leaf" } };
    const box = emitter.dyn.nativeSlotBoxHelper(recursive);
    expect(emitter.dyn.nativeSlotBoxHelper(recursive)).toBe(box);
    const scalar = emitter.dyn.nativeSlotBoxHelper(F64);
    const boolean = emitter.dyn.nativeSlotBoxHelper(BOOL);
    const llvm = emitter.emitParts().join("\n");
    expect(llvm).toMatch(
      /internal constant \{ ptr, ptr, ptr, ptr \} \{ ptr @\S+_get, ptr @\S+_set, ptr @sc_slot_box_\d+, ptr @sc_slot_unbox_\d+ \}/,
    );
    expect(llvm).toContain("declare zeroext i1 @scr_dyn_typed_ref_bind_array(ptr, ptr)");
    expect(llvm).not.toContain("declare void @scr_dyn_typed_ref_bind_array");
    const body = (name: string): string =>
      llvm.match(new RegExp(`^define internal ptr @${name}\\(.*?^}`, "ms"))![0];
    expect(body(box)).toContain("inttoptr i64 %slot to ptr");
    expect(body(box)).toContain("bind.array.fail");
    expect(body(box)).toContain("call void @scr_dyn_release_v(ptr %result)");
    expect(body(scalar)).toContain("bitcast i64 %slot to double");
    expect(body(boolean)).toContain("trunc i64 %slot to i1");
    expect(llvm).toContain("snapshot.fail");
    const symbols = [...llvm.matchAll(/^define .*? @(\S+)\(/gm)].map((match) => match[1]);
    expect(new Set(symbols).size).toBe(symbols.length);
  }
});

test("native slot boxing preserves opaque identity and dispatches actual union arms", () => {
  for (const pointerBits of [32, 64] as const) {
    const module = sharedGraph(0);
    const decoder: IrType = { kind: "record", shapeId: "decoder" };
    module.records!.push({
      id: "decoder",
      fields: [
        { name: "%TextDecoder", type: F64 },
        { name: "%state", type: DYN },
      ],
    });
    const mixed: IrType = { kind: "union", unionId: "mixed" };
    module.unions!.push({ id: "mixed", arms: [decoder, F64, BOOL, UNDEFINED_T] });
    const emitter = new LlEmitter(module, { pointerBits });
    const helper = emitter.dyn.nativeSlotBoxHelper(mixed);
    const opaque = emitter.dyn.nativeSlotBoxHelper(decoder);
    const llvm = emitter.emitParts().join("\n");
    const body = (name: string): string =>
      llvm.match(new RegExp(`^define internal ptr @${name}\\(.*?^}`, "ms"))![0];
    expect(body(helper)).toContain("switch i32");
    expect(body(helper)).toContain("@scr_union_get_f64(");
    expect(body(helper)).toContain("@scr_union_get_bool(");
    expect(body(helper)).toContain("@scr_dyn_undefined(");
    expect(body(opaque)).toMatch(/@scr_dyn_new_(?:traced_)?typed_ref/);
    expect(body(opaque)).not.toContain("getelementptr");
    expect(body(opaque)).not.toContain("@scr_dyn_obj_get");
  }
});

test.each([32, 64] as const)(
  "recursive adapter recipes are complete before field boxing on %s-bit targets",
  (pointerBits) => {
    for (const family of ["record", "class", "opaque"] as const) {
      for (const writable of [false, true]) {
        for (const entry of ["adapter", "nativeOps"] as const) {
          const module = sharedGraph(0);
          module.records = [];
          module.unions = [];
          const loc = module.functions[0]!.loc;
          const types: IrType[] = ["First", "Second"].map((name) =>
            family === "record"
              ? { kind: "record", shapeId: name }
              : { kind: "object", className: name },
          );
          types.forEach((type, index) => {
            const fields = [
              { name: "peer", type: types[1 - index]! },
              { name: "self", type },
            ];
            if (type.kind === "record") {
              module.records!.push({ id: type.shapeId, fields });
              return;
            }
            if (type.kind !== "object") throw new Error("expected recursive class");
            if (family === "opaque") fields.push({ name: "hash", type: { kind: "cryptoHash" } });
            (module.classes ??= []).push({
              name: type.className,
              fields: [
                ...fields,
                { name: DYN_CLASS_PROPERTIES, type: DYN, visibility: "internal" },
              ],
              tracksOwnFields: true,
              nativePropertyBagHelper: `prepare.${type.className}`,
              loc,
            });
            module.functions.push({
              name: `prepare.${type.className}`,
              params: [{ localId: "value", name: "value", type }],
              locals: [{ id: "value", name: "value", type, mutable: false }],
              returnType: DYN,
              body: [{ kind: "return", value: { kind: "dynObjLit", type: DYN, loc }, loc }],
              loc,
            });
          });
          if (writable) {
            module.functions.push({
              name: "write",
              params: [{ localId: "value", name: "value", type: DYN }],
              locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
              returnType: VOID,
              body: [
                {
                  kind: "exprStmt",
                  expr: {
                    kind: "libCall",
                    fn: "dyn.keySet",
                    args: [
                      { kind: "varRef", localId: "value", type: DYN, loc },
                      { kind: "strLit", value: "self", type: STRING, loc },
                      { kind: "dynObjLit", type: DYN, loc },
                    ],
                    type: VOID,
                    loc,
                  },
                  loc,
                },
              ],
              loc,
            });
          }
          expect(validateModule(module)).toEqual([]);
          const emitter = new LlEmitter(module, { pointerBits });
          expect(emitter.liveViewsReadOnly).toBe(!writable);
          // Both entry routes must publish complete recipes before the self
          // and mutual field reads recursively create their slot boxers.
          if (entry === "nativeOps") emitter.nativeObjects.ops(types[0]!);
          else emitter.liveDynRefAdapter(types[0]!);
          const adapters = types.map((type) => emitter.liveDynRefAdapter(type));
          const boxers = types.map((type) => emitter.dyn.nativeSlotBoxHelper(type));
          const llvm = emitter.emitParts().join("\n");
          adapters.forEach((adapter, index) => {
            const body = llvm.match(
              new RegExp(`^define internal ptr @${boxers[index]}\\(.*?^}`, "ms"),
            )![0];
            const opaque = family === "opaque";
            expect(adapter.commit === "null").toBe(!writable || opaque);
            expect(body).toContain(`ptr @${adapter.snapshot}, ptr ${adapter.commit})`);
            expect(body).toContain(
              `@scr_dyn_typed_ref_bind_native_object(ptr %result, ptr ${adapter.nativeObjectOps})`,
            );
            expect(llvm).toContain(`${adapter.nativeObjectOps} = internal constant`);
            const view = family === "record" ? "record" : "class";
            const ops = family === "record" ? adapter.recordOps : adapter.classOps;
            expect(body).toContain(`@scr_dyn_typed_ref_bind_${view}(ptr %result, ptr ${ops})`);
            expect(llvm).toContain(`${ops} = internal`);
            if (opaque) {
              expect(adapter.snapshot).toBe("scr_dyn_class_view_unavailable");
            } else {
              if (writable) expect(llvm).toContain(`define internal void ${adapter.commit}(`);
              else expect(llvm).not.toContain(`@${adapter.snapshot}_commit`);
              if (family === "class") {
                const snapshot = llvm.match(
                  new RegExp(`^define internal ptr @${adapter.snapshot}\\(.*?^}`, "ms"),
                )![0];
                expect(snapshot).toContain("@scr_native_property_bag_facts");
                expect(snapshot).toContain("@scr_dyn_table_set_data");
                expect(snapshot).not.toContain("@scr_dyn_obj_set(");
                if (writable) {
                  const commit = llvm.match(
                    new RegExp(`^define internal void ${adapter.commit}\\(.*?^}`, "ms"),
                  )![0];
                  expect(commit).toContain("@scr_dyn_table_set_data");
                  expect(commit).not.toContain("@scr_dyn_obj_set(ptr %bag");
                }
              }
            }
          });
          const symbols = [...llvm.matchAll(/^define .*? @(\S+)\(/gm)].map((match) => match[1]);
          expect(new Set(symbols).size).toBe(symbols.length);
        }
      }
    }
  },
);

test.each([32, 64] as const)(
  "opaque native records bind integrity without a view on %s-bit targets",
  (pointerBits) => {
    const module = sharedGraph(0);
    const type: IrType = { kind: "record", shapeId: "opaque" };
    module.records!.push({
      id: "opaque",
      fields: [{ name: "%get:value", type: funcOf([], F64) }],
    });
    const emitter = new LlEmitter(module, { pointerBits });
    const helper = emitter.dyn.nativeSlotBoxHelper(type);
    const llvm = emitter.emitParts().join("\n");
    const body = llvm.match(new RegExp(`^define internal ptr @${helper}\\(.*?^}`, "ms"))![0];
    expect(body).toContain("@scr_dyn_typed_ref_bind_native_object(ptr %result, ptr @sc_native_");
    expect(body).not.toContain("@scr_dyn_typed_ref_bind_record");
    expect(body).not.toContain("@scr_dyn_typed_ref_materialize");
    expect(llvm).toMatch(/@sc_native_\d+_facts\(ptr %p, i(?:32|64) %i\)/);
  },
);

test("native slot extraction keeps opaque leaves exact inside recursive containers", () => {
  for (const pointerBits of [32, 64] as const) {
    const module = sharedGraph(2);
    const decoder: IrType = { kind: "record", shapeId: "decoder" };
    module.records!.push({
      id: "decoder",
      fields: [
        { name: "%TextDecoder", type: F64 },
        { name: "%state", type: DYN },
      ],
    });
    module.records![0]!.fields.push({ name: "decoder", type: decoder });
    module.unions!.push(
      { id: "optionalDecoder", arms: [decoder, UNDEFINED_T] },
      { id: "reversedDecoder", arms: [UNDEFINED_T, decoder] },
    );
    const types: IrType[] = [
      decoder,
      { kind: "array", elem: decoder },
      { kind: "union", unionId: "optionalDecoder" },
      { kind: "union", unionId: "reversedDecoder" },
      { kind: "union", unionId: "input0" },
      { kind: "union", unionId: "input1" },
    ];
    const emitter = new LlEmitter(module, { pointerBits });
    const helpers = types.map((type) => emitter.dyn.nativeSlotUnboxHelper(type));
    expect(new Set(helpers).size).toBe(types.length);
    expect(types.map((type) => emitter.dyn.nativeSlotUnboxHelper(type))).toEqual(helpers);
    // The public helper also rejects a forged decoder without visiting its
    // private fields; exact-only extraction does not depend on slot mode.
    emitter.dyn.dynMatchHelper(decoder);
    emitter.dyn.dynCheckHelper(decoder);
    const llvm = emitter.emitParts().join("\n");
    const exact = [
      ...llvm.matchAll(/^define internal .*; exact native record:decoder\n([\s\S]*?)^}/gm),
    ];
    expect(exact).toHaveLength(4);
    for (const body of exact.map((match) => match[1]!)) {
      expect(body).toContain("@scr_dyn_typed_ref_is(");
      expect(body).not.toContain("@scr_dyn_obj_get");
      expect(body).not.toContain("materialize");
    }
    const symbols = [...llvm.matchAll(/^define .*? @(\S+)\(/gm)].map((match) => match[1]);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(llvm).toContain("@scr_dyn_build_visit(");
    expect(llvm).toContain("@scr_dyn_match_visit(");
    for (const helper of helpers) {
      const body = llvm.match(
        new RegExp(`^define internal zeroext i1 @${helper}\\(.*?^}`, "ms"),
      )?.[0];
      expect(body).toBeDefined();
      expect(body).toContain("ptr %out");
      expect(body!.match(/store i64/g)).toHaveLength(1);
      expect(body).toContain("ret i1 false");
      expect(body).toContain("ret i1 true");
    }
  }
});

test("structural codec unions select exact capsules before any arm can materialize them", () => {
  for (const pointerBits of [32, 64] as const) {
    const module = sharedGraph(0);
    const encoder: IrType = { kind: "record", shapeId: "encoder" };
    const decoder: IrType = { kind: "record", shapeId: "decoder" };
    module.records!.push(
      { id: "encoder", fields: [{ name: "%TextEncoder", type: F64 }] },
      {
        id: "decoder",
        fields: [
          { name: "%TextDecoder", type: F64 },
          { name: "%state", type: DYN },
        ],
      },
    );
    const variants: IrType[][] = [
      [encoder, UNDEFINED_T],
      [UNDEFINED_T, encoder],
      [decoder, UNDEFINED_T],
      [UNDEFINED_T, decoder],
      [encoder, F64],
      [F64, encoder],
      [decoder, STRING, UNDEFINED_T],
      [UNDEFINED_T, STRING, decoder],
      [encoder, decoder],
      [decoder, encoder],
    ];
    module.unions!.push(...variants.map((arms, index) => ({ id: `codec${index}`, arms })));
    const emitter = new LlEmitter(module, { pointerBits });
    const helpers = variants.map((arms, index) => {
      const type: IrType = { kind: "union", unionId: `codec${index}` };
      const nested: IrType = { kind: "array", elem: type };
      emitter.dyn.dynMatchHelper(nested);
      emitter.dyn.dynCheckHelper(nested);
      return {
        arms,
        matcher: emitter.dyn.dynMatchHelper(type),
        builder: emitter.dyn.dynCheckHelper(type),
      };
    });
    const keys = new Map<IrType, string>([
      [encoder, emitter.cstr("record:encoder")],
      [decoder, emitter.cstr("record:decoder")],
    ]);
    const llvm = emitter.emitParts().join("\n");
    for (const { arms, matcher, builder } of helpers) {
      const match = llvm.match(
        new RegExp(`^define internal zeroext i1 @${matcher}\\(.*?^}`, "ms"),
      )?.[0];
      const build = llvm.match(new RegExp(`^define internal ptr @${builder}\\(.*?^}`, "ms"))?.[0];
      expect(match).toBeDefined();
      expect(build).toBeDefined();
      const opaque = arms.filter((arm) => keys.has(arm));
      for (const arm of opaque) {
        const probe = `@scr_dyn_typed_ref_is(ptr %d, ptr ${keys.get(arm)}`;
        expect(match!.indexOf(probe)).toBeGreaterThan(-1);
        expect(match!.indexOf(probe)).toBeLessThan(
          match!.indexOf("@scr_dyn_typed_ref_materialize("),
        );
        expect(build!.indexOf(probe)).toBeGreaterThan(-1);
        expect(build!.indexOf(probe)).toBeLessThan(build!.indexOf("call zeroext i1 @sc_dm_"));
      }
      expect(match!.match(/du\.exact\d+:\n\s+ret i1 true/g)).toHaveLength(opaque.length);
      // A native hit jumps into the ordinary selected-arm builder, preserving
      // its nullable representation, tag, retain and pending cleanup.
      expect(build!.match(/du\.exact\d+:\n\s+br label %dcu\.h\d+/g)).toHaveLength(opaque.length);
      expect(match).toMatch(
        /dm\.view\.u\d+:\n\s+call void @scr_dyn_release_v\(ptr %t\d+\)\n\s+ret i1 false/,
      );
      expect(match!.indexOf("dm.view.u")).toBeLessThan(
        match!.indexOf(`call zeroext i1 @${matcher}(`),
      );
    }
  }
});

test("native slot unions guard discriminators and match non-adaptable function signatures", () => {
  for (const pointerBits of [32, 64] as const) {
    const module = sharedGraph(0);
    const variant: IrType = { kind: "record", shapeId: "variant" };
    const callback: IrType = {
      kind: "func",
      params: [{ kind: "array", elem: STRING }],
      ret: STRING,
      rest: true,
      restAbi: "typed",
    };
    module.records!.push({ id: "variant", fields: [{ name: "kind", type: STRING }] });
    module.unions!.push(
      ...["left", "right"].map((value) => ({
        id: value,
        arms: [variant, F64],
        discriminant: { field: "kind", cases: [{ tag: 0, values: [value] }] },
      })),
      { id: "callback", arms: [callback, F64, UNDEFINED_T] },
    );
    const emitter = new LlEmitter(module, { pointerBits });
    for (const unionId of ["left", "right", "callback"])
      emitter.dyn.nativeSlotUnboxHelper({ kind: "union", unionId });
    const llvm = emitter.emitParts().join("\n");
    const guarded = [...llvm.matchAll(/^define internal .*\n([\s\S]*?)^}/gm)]
      .map((match) => match[1]!)
      .filter((body) => body.includes("@scr_dyn_field_eq_str("));
    expect(guarded).toHaveLength(4);
    for (const body of guarded) {
      expect(body.indexOf("@scr_dyn_typed_ref_is(")).toBeLessThan(
        body.indexOf("@scr_dyn_field_eq_str("),
      );
      expect(body).toContain("du.literal.u");
      expect(body).not.toContain("du.native.value");
    }
    expect(llvm).toContain("call ptr @scr_dyn_func_unbox_exact(");
    expect(llvm).not.toContain("@sc_dfa_");
    expect(llvm).toMatch(/call void @scr_closure_release_v\(ptr %t\d+\)/);
  }
});

test("opaque native record discriminators read only the proven data slot", () => {
  const cases: {
    type: IrType;
    values: (string | number | boolean)[];
    comparison: string;
    arms?: IrType[];
  }[] = [
    { type: STRING, values: ["left", "right"], comparison: "call zeroext i1 @scr_str_eq(" },
    { type: BOOL, values: [true, false], comparison: "icmp eq i1" },
    { type: F64, values: [1, 2], comparison: "fcmp oeq double" },
    {
      type: { kind: "union", unionId: "literal" },
      values: ["left", 1],
      comparison: "du.value",
      arms: [STRING, F64],
    },
    {
      type: { kind: "union", unionId: "literal" },
      values: [true, 1],
      comparison: "du.value",
      arms: [BOOL, F64],
    },
    {
      type: { kind: "union", unionId: "literal" },
      values: ["left", "right"],
      comparison: "du.value",
      arms: [STRING, UNDEFINED_T],
    },
  ];
  for (const pointerBits of [32, 64] as const) {
    for (const { type, values, comparison, arms } of cases) {
      const module = sharedGraph(0);
      if (arms) module.unions!.push({ id: "literal", arms });
      const variant: IrType = { kind: "record", shapeId: "opaqueVariant" };
      module.records!.push({
        id: "opaqueVariant",
        fields: [
          { name: "kind", type },
          { name: "%get:unrelated", type: { kind: "func", params: [], ret: STRING } },
        ],
      });
      module.unions!.push(
        ...values.map((value, index) => ({
          id: `variant${index}`,
          arms: [variant, F64],
          discriminant: { field: "kind", cases: [{ tag: 0, values: [value] }] },
        })),
      );
      const emitter = new LlEmitter(module, { pointerBits });
      for (let index = 0; index < values.length; index++)
        emitter.dyn.nativeSlotUnboxHelper({ kind: "union", unionId: `variant${index}` });
      const llvm = emitter.emitParts().join("\n");
      const bodies = [...llvm.matchAll(/^define internal .*\n([\s\S]*?)^}/gm)]
        .map((match) => match[1]!)
        .filter((body) => body.includes("du.native.value"));
      // Matcher and builder for each literal set share one physical shape.
      expect(bodies).toHaveLength(4);
      for (const body of bodies) {
        expect(body).toContain("@scr_dyn_typed_ref_is(");
        expect(body).toContain(comparison);
        expect(body).toContain("getelementptr inbounds %");
        expect(body).not.toContain("@scr_dyn_field_eq_");
        expect(body).not.toContain("@scr_dyn_obj_get");
        expect(body).not.toContain("materialize");
        const nativeRead = body.match(/^du\.native\.value\d+:\n((?:  .*\n)*)/m)?.[1];
        expect(nativeRead).toBeDefined();
        expect(nativeRead).not.toContain("@scr_dyn_typed_ref_unbox(");
        if (!arms) expect(nativeRead).toContain(comparison);
        if (type.kind === "bool") expect(body).toContain("trunc i8");
      }
    }
  }
});

test("overlapping union roots share the recursive materialization graph", () => {
  for (const pointerBits of [32, 64] as const) {
    for (const roots of [2, 32]) {
      const llvm = emitLlvmModule(sharedGraph(roots), { pointerBits });
      const materializers = [
        ...llvm.matchAll(
          /^define internal ptr @\S+(?:\.i32)?\(ptr %p\).*; materialize live stream value (.+)$/gm,
        ),
      ];
      // One record root, one recursive leaf, and its array, independent of
      // how many enclosing union arms reach the shared graph.
      expect(materializers).toHaveLength(3);
      expect(new Set(materializers.map((match) => match[1])).size).toBe(3);
      // Exposed roots retain their live union adapter; nested slot unions
      // dispatch through the exact box recipe shared by every root.
      expect(llvm.match(/; materialize live union value /g)).toHaveLength(roots);
      const symbols = [...llvm.matchAll(/^define .*? @(\S+)\(/gm)].map((match) => match[1]);
      expect(new Set(symbols).size).toBe(symbols.length);
    }
  }
});

test("converter registries belong to one emitted module", () => {
  const original = sharedGraph(2);
  const first = emitLlvmModule(original);
  const changed = sharedGraph(2);
  changed.records![0]!.fields.push({ name: "extra", type: STRING });
  const second = emitLlvmModule(changed);
  expect(second).not.toBe(first);
  expect(emitLlvmModule(original)).toBe(first);
});

test("live record capsules bind field hooks in snapshot order", () => {
  const module = sharedGraph(1);
  module.records!.push({
    id: "numbered",
    fields: [
      { name: "0", type: STRING },
      { name: "name", type: STRING },
    ],
  });
  module.unions!.push({
    id: "numberedInput",
    arms: [{ kind: "record", shapeId: "numbered" }, STRING],
  });
  const loc = { file: "live-references.ts", start: 0, end: 0 };
  const type: IrType = { kind: "union", unionId: "numberedInput" };
  module.functions.push({
    name: "boxNumbered",
    params: [{ name: "value", localId: "value", type }],
    returnType: DYN,
    locals: [{ id: "value", name: "value", type, mutable: false }],
    loc,
    body: [
      {
        kind: "return",
        value: {
          kind: "dynFrom",
          value: { kind: "varRef", localId: "value", type, loc },
          liveRef: true,
          type: DYN,
          loc,
        },
        loc,
      },
    ],
  });
  const llvm = emitLlvmModule(module, { pointerBits: 64 });
  const tables = [
    ...llvm.matchAll(
      /^@(\S+)_rops = internal global \{ i64, ptr, ptr, ptr, i8, ptr \} \{ i64 (\d+), /gm,
    ),
  ];
  // root and leaf get field hooks; the record with an index-like field name
  // keeps every operation on its snapshot, whose keys sort that name first.
  expect(tables.map((match) => Number(match[2])).sort()).toEqual([2, 3]);
  expect(llvm).toMatch(/; materialize live stream value record:numbered$/m);
  const leafNames = llvm.match(/^@\S+_names = internal constant \[3 x ptr\] \[(.+)\]$/m);
  expect(leafNames).not.toBeNull();
  const binds = llvm.match(/call void @scr_dyn_typed_ref_bind_record\(/g) ?? [];
  expect(binds.length).toBeGreaterThan(0);
  expect(llvm).toMatch(
    /define internal zeroext i1 @\S+_has(?:\.i32)?\(ptr %p, i64 %i\).*; live field presence of record:leaf/,
  );
});

test("class instance capsules bind prototype member names by exact class", () => {
  const loc = { file: "live-references.ts", start: 0, end: 0 };
  const base: IrType = { kind: "object", className: "Base" };
  const module: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    classes: [
      { name: "Base", fields: [{ name: "size", type: STRING }], prototypeNames: ["grow"], loc },
      {
        name: "Derived",
        base: "Base",
        fields: [{ name: "size", type: STRING }],
        prototypeNames: ["shrink", "grow"],
        loc,
      },
    ],
    functions: [
      { name: "main", params: [], returnType: VOID, locals: [], body: [], loc },
      {
        name: "box",
        params: [{ name: "value", localId: "value", type: base }],
        returnType: DYN,
        locals: [{ id: "value", name: "value", type: base, mutable: false }],
        loc,
        body: [
          {
            kind: "return",
            value: {
              kind: "dynFrom",
              value: { kind: "varRef", localId: "value", type: base, loc },
              liveRef: true,
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      },
    ],
  };
  const llvm = emitLlvmModule(module, { pointerBits: 64 });
  const tables = [...llvm.matchAll(/^@(\S+)_cnames = internal constant \[(\d+) x ptr\]/gm)].map(
    (match) => Number(match[2]),
  );
  // Base: constructor, grow. Derived: constructor, shrink, grow (deduplicated).
  expect(tables.sort()).toEqual([2, 3]);
  expect(llvm).toMatch(
    /^define internal ptr @\S+_cexact\(ptr %p\).*; exact class members of Base$/m,
  );
  expect(llvm).toMatch(/call void @scr_dyn_typed_ref_bind_class\(/);
});
