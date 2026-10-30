import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  DYN_CLASS_PROPERTIES,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  funcOf,
  type IrExpr,
  type IrClassField,
  type IrModule,
  type IrType,
} from "../../ir/ir.js";
import { validateModule } from "../../ir/validate.js";
import { deserializeModule, serializeModule } from "../../ir/serialize.js";
import { emitLlvmModule, LlEmitter } from "./emitter.js";

const loc = { file: "native-properties.ts", start: 0, end: 1 };
const record: IrType = { kind: "record", shapeId: "item" };
const optional: IrType = { kind: "union", unionId: "optional" };
const value: IrExpr = { kind: "varRef", localId: "item", type: record, loc };
const mod: IrModule = {
  irVersion: 17,
  sourceFile: loc.file,
  entry: "main",
  records: [
    {
      id: "item",
      fields: [
        { name: "%get:read", type: funcOf([], F64) },
        { name: "%set:read", type: funcOf([F64], VOID) },
        { name: "%x", type: F64 },
        { name: "nul\0key", type: STRING },
        { name: "optional", type: optional },
        { name: "value", type: F64 },
      ],
    },
  ],
  unions: [{ id: "optional", arms: [STRING, UNDEFINED_T] }],
  functions: [
    {
      name: "main",
      params: [{ localId: "item", name: "item", type: record }],
      locals: [{ id: "item", name: "item", type: record, mutable: false }],
      returnType: VOID,
      loc,
      body: [
        {
          kind: "exprStmt",
          expr: { kind: "intrinsic", name: "native.isFrozen", args: [value], type: BOOL, loc },
          loc,
        },
      ],
    },
  ],
};

function defineProperty(source: IrModule): void {
  const fn = source.functions[0]!;
  fn.params.push({ localId: "dynamic", name: "dynamic", type: DYN });
  fn.locals.push({ id: "dynamic", name: "dynamic", type: DYN, mutable: false });
  fn.body.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.defineProperty",
      type: DYN,
      loc,
      args: [
        { kind: "varRef", localId: "dynamic", type: DYN, loc },
        {
          kind: "dynFrom",
          value: { kind: "strLit", value: "value", type: STRING, loc },
          type: DYN,
          loc,
        },
        { kind: "dynObjLit", fields: [], type: DYN, loc },
      ],
    },
    loc,
  });
}

test.each([32, 64] as const)(
  "native facts use raw presence and length-aware keys on %s-bit layouts",
  (pointerBits) => {
    expect(validateModule(mod)).toEqual([]);
    const llvm = emitLlvmModule(mod, { pointerBits });
    const facts = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal i32 @sc_native_0_facts("))!;
    expect(facts).toContain("@sc_nullable_absent");
    expect(facts).toMatch(/select i1 %\w+, i32 0, i32 31/);
    expect(facts).toContain("ret i32 25");
    expect(facts).not.toMatch(/call .*@(scr_dyn|sc_slot_box|sc_f_)/);
    expect(llvm).toContain(
      `@sc_native_0_lengths = internal constant [5 x i${pointerBits}] [i${pointerBits} 4, i${pointerBits} 2, i${pointerBits} 7, i${pointerBits} 8, i${pointerBits} 5]`,
    );
    expect(llvm).toContain(`ptr @scr_record_source_view, ptr null, ptr null`);
    const read = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal ptr @sc_native_0_read("))!;
    expect(read).toContain(`@sc_native_0_facts(ptr %p, i${pointerBits} %i)`);
    expect(read.indexOf("and i32")).toBeLessThan(read.indexOf("getelementptr"));
    // The accessor property returns its getter/setter identities without
    // invoking either function or boxing other fields first.
    expect(read).toMatch(/switch i32 %part, label %\S+ \[ i32 1, label %\S+ i32 2, label %\S+ \]/);
    expect(read).not.toMatch(/@(scr_dyn_call|scr_dyn_typed_ref_materialize|sc_ldr_)/);
    expect(llvm).toContain(
      `{ ptr, i${pointerBits}, ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr, ptr } { ptr null`,
    );
  },
);

test.each([32, 64] as const)(
  "record definitions convert one slot and finish metadata before release on %s-bit targets",
  (pointerBits) => {
    const source = structuredClone(mod);
    const scalar: IrType = { kind: "union", unionId: "scalar" };
    const boxed: IrType = { kind: "union", unionId: "boxed" };
    source.unions!.push(
      { id: "scalar", arms: [F64, UNDEFINED_T] },
      { id: "boxed", arms: [STRING, F64] },
    );
    source.records![0] = {
      id: "item",
      fields: [
        { name: "boolean", type: BOOL },
        { name: "boxed", type: boxed },
        { name: "inline", type: scalar },
        { name: "nullable", type: optional },
        { name: "number", type: F64 },
        { name: "text", type: STRING },
      ],
      declaredOrder: ["boxed", "inline", "nullable", "text", "boolean", "number"],
    };
    const readOnly = emitLlvmModule(source, { pointerBits });
    expect(readOnly).not.toContain("@sc_native_0_apply");
    expect(readOnly).not.toContain("@scr_native_mutation_recheck");
    defineProperty(source);
    expect(validateModule(source)).toEqual([]);
    const llvm = emitLlvmModule(source, { pointerBits });
    const apply = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal zeroext i1 @sc_native_0_apply("))!;
    expect(apply).toBeDefined();
    expect(apply).not.toMatch(/@(scr_dyn_typed_ref_materialize|sc_tr_commit|sc_dm_)/);
    expect(apply.match(/call (?:zeroext i1|double|ptr) @sc_dc_/g)).toHaveLength(6);
    expect(apply).toContain("call zeroext i1 @sc_dc_");
    const slots = [
      ...apply
        .slice(apply.search(/^native\.convert\d+:/m))
        .matchAll(/getelementptr inbounds %sc_rs_item, ptr %p, i64 0, i32 (\d+)/g),
    ];
    expect(slots.map((match) => match[1])).toEqual(["2", "3", "4", "6", "1", "5"]);
    const blocks = apply.split(/native\.apply\.field\d*:\n/).slice(1);
    expect(blocks).toHaveLength(6);
    for (const block of blocks) {
      const converted = block.indexOf("@sc_dc_"),
        recheck = block.indexOf("@scr_native_mutation_recheck");
      const address = block.indexOf("getelementptr inbounds %sc_rs_item");
      expect(recheck).toBeGreaterThan(converted);
      expect(address).toBeGreaterThan(recheck);
      const store = block.slice(address);
      const finish = store.indexOf("@scr_native_mutation_finish");
      expect(finish).toBeGreaterThan(store.indexOf("store "));
      const release = store.search(/call void @(?:scr_|sc_).*release/);
      if (release >= 0) expect(release).toBeGreaterThan(finish);
    }
    // Attribute-only requests have no checked conversion or slot access.
    const attributes = apply.match(/^native\.attributes\d+:\n([\s\S]*?)^native\.delete\d+:/m)![1]!;
    expect(attributes).toContain("@scr_native_mutation_recheck");
    expect(attributes).toContain("@scr_native_mutation_finish");
    expect(attributes).not.toMatch(/@sc_dc_|getelementptr/);
    expect(apply).toMatch(/zext i1 %\w+ to i8/);
    expect(apply).toContain("getelementptr inbounds { i32, i64 }");
  },
);

test.each([32, 64] as const)(
  "opaque record fields keep reflection without generating unsupported writers on %s-bit targets",
  (pointerBits) => {
    const source = structuredClone(mod);
    source.records![0] = {
      id: "item",
      fields: [
        { name: "hash", type: { kind: "cryptoHash" } },
        { name: "value", type: F64 },
      ],
    };
    defineProperty(source);
    expect(validateModule(source)).toEqual([]);
    const llvm = emitLlvmModule(source, { pointerBits });
    const apply = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal zeroext i1 @sc_native_0_apply("))!;
    expect(apply.match(/call (?:zeroext i1|double|ptr) @sc_dc_/g)).toHaveLength(1);
    expect(apply).toContain("@scr_native_mutation_finish");
    expect(llvm).toContain("@sc_native_0_read");
    expect(llvm).not.toContain("; check cryptoHash");
  },
);

test.each([32, 64] as const)(
  "record metadata keeps serializer order and public field visibility on %s-bit targets",
  (pointerBits) => {
    const source = structuredClone(mod);
    source.records![0] = {
      id: "item",
      fields: [
        { name: "%call", type: funcOf([], F64) },
        { name: "%x", type: F64 },
        { name: "second", type: F64 },
        { name: "value", type: F64 },
      ],
      declaredOrder: ["value", "%x", "second"],
    };
    expect(validateModule(source)).toEqual([]);
    const llvm = emitLlvmModule(source, { pointerBits });
    const preparation = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal zeroext i1 @sc_native_0_prepare("))!;
    expect(preparation).toContain(
      `@scr_record_source_prepare(ptr %p, ptr @sc_rnames_0, ptr @sc_rnames_0_lens, i${pointerBits} 4, ptr @sc_native_0_ops)`,
    );
    expect(preparation).not.toMatch(/@(sc_slot_box|scr_dyn_typed_ref_materialize|sc_f_)/);
    // Metadata order differs from physical slots, and raw serializer names
    // still contain the hidden callable after the three public data keys.
    expect(llvm).toContain(
      `@sc_native_0_lengths = internal constant [3 x i${pointerBits}] [i${pointerBits} 5, i${pointerBits} 2, i${pointerBits} 6]`,
    );
    expect(llvm).toContain(
      `@sc_rnames_0_lens = internal constant [4 x i${pointerBits}] [i${pointerBits} 5, i${pointerBits} 2, i${pointerBits} 6, i${pointerBits} 5]`,
    );
    const read = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal ptr @sc_native_0_read("))!;
    expect(read).not.toMatch(/getelementptr[^\n]+i32 1\b/);
    expect(read.match(/getelementptr[^\n]+i32 [234]\b/g)?.map((line) => line.slice(-1))).toEqual([
      "4",
      "2",
      "3",
    ]);
    expect(llvm).toContain(
      "ptr @scr_record_source_view, ptr @sc_native_0_prepare, ptr null, ptr @sc_native_0_read",
    );
  },
);

test.each([32, 64] as const)(
  "exposed scalar and empty records trace metadata and unlink before teardown on %s-bit targets",
  (pointerBits) => {
    for (const fields of [[], [{ name: "value", type: STRING }]]) {
      const source = structuredClone(mod);
      source.records = [{ id: "item", fields }];
      const llvm = emitLlvmModule(source, { pointerBits });
      const definitions = llvm.split(/^define /m);
      const trace = definitions.find((fn) => fn.startsWith("internal void @sc_rtrace_item("))!;
      const free = definitions.find((fn) => fn.startsWith("internal void @sc_rgcfree_item("))!;
      expect(trace).toContain("call void @scr_record_source_trace(ptr %o, ptr %visit, ptr %ctx)");
      expect(trace.match(/call void @scr_record_source_trace/g)).toHaveLength(1);
      expect(free).toContain("entry:\n  call void @scr_record_source_collected(ptr %o)");
      expect(free).not.toContain("@scr_dyn_release");
      if (fields.length) expect(free).toContain("@scr_str_release");
      expect(llvm).toContain("@sc_rtrace_item.cyctype");
      // Without an exposure root, the scalar layout needs neither a cycle
      // header nor a dependency on the dynamic metadata runtime.
      source.functions[0]!.body = [];
      const plain = emitLlvmModule(source, { pointerBits });
      expect(plain).not.toContain("@scr_record_source_trace");
      expect(plain).not.toContain("@sc_rtrace_item.cyctype");
    }
  },
);

test.each([32, 64] as const)(
  "registered Error views retain record metadata ownership on %s-bit targets",
  (pointerBits) => {
    const source = structuredClone(mod);
    source.records = [{ id: "item", fields: [{ name: "value", type: F64 }] }];
    source.functions[0]!.body = [];
    source.classes = [
      { name: "%Error", runtime: true, fields: [], methods: [], loc },
      {
        name: "Problem",
        base: "%Error",
        fields: [{ name: "detail", type: record }],
        methods: [],
        loc,
      },
    ];
    expect(validateModule(source)).toEqual([]);
    const llvm = emitLlvmModule(source, { pointerBits });
    expect(llvm).toContain("call void @scr_error_register_dyn");
    expect(llvm).toContain("@sc_rtrace_item.cyctype");
    const trace = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal void @sc_rtrace_item("))!;
    expect(trace).toContain("call void @scr_record_source_trace(ptr %o, ptr %visit, ptr %ctx)");
    const free = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal void @sc_rgcfree_item("))!;
    expect(free).toContain("call void @scr_record_source_collected(ptr %o)");
  },
);

test.each([32, 64] as const)(
  "opaque class capsules and deferred receivers carry native ops on %s-bit targets",
  (pointerBits) => {
    const type: IrType = { kind: "object", className: "Opaque" };
    const callback = funcOf([], VOID);
    const receiver: IrExpr = { kind: "varRef", localId: "item", type, loc };
    const source: IrModule = {
      irVersion: 17,
      sourceFile: loc.file,
      entry: "main",
      classes: [
        {
          name: "Opaque",
          tracksOwnFields: true,
          nativePropertyBagHelper: "prepare.Opaque",
          prototypeNames: ["toString"],
          loc,
          fields: [
            { name: "hash", type: { kind: "cryptoHash" } },
            { name: DYN_CLASS_PROPERTIES, type: DYN, visibility: "internal" },
          ],
        },
      ],
      functions: [
        {
          name: "main",
          params: [
            { localId: "item", name: "item", type },
            { localId: "callback", name: "callback", type: callback },
          ],
          locals: [
            { id: "item", name: "item", type, mutable: false },
            { id: "callback", name: "callback", type: callback, mutable: false },
          ],
          returnType: VOID,
          loc,
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "callValue",
                callee: { kind: "varRef", localId: "callback", type: callback, loc },
                receiver: { kind: "dynFrom", value: receiver, type: DYN, loc },
                args: [],
                type: VOID,
                loc,
              },
              loc,
            },
          ],
        },
        {
          name: "prepare.Opaque",
          params: [{ localId: "item", name: "item", type }],
          locals: [{ id: "item", name: "item", type, mutable: false }],
          returnType: DYN,
          loc,
          body: [
            {
              kind: "fieldSet",
              obj: receiver,
              className: "Opaque",
              field: DYN_CLASS_PROPERTIES,
              value: { kind: "dynObjLit", fields: [], type: DYN, loc },
              loc,
            },
            {
              kind: "return",
              value: {
                kind: "fieldGet",
                obj: receiver,
                className: "Opaque",
                field: DYN_CLASS_PROPERTIES,
                type: DYN,
                loc,
              },
              loc,
            },
          ],
        },
      ],
    };
    expect(validateModule(source)).toEqual([]);
    const emitter = new LlEmitter(source, { pointerBits });
    const adapter = emitter.liveDynRefAdapter(type);
    expect(adapter.snapshot).toBe("scr_dyn_class_view_unavailable");
    expect(adapter.nativeObjectOps).toBeDefined();
    expect(adapter.classOps).toBeDefined();
    const helper = emitter.dyn.nativeSlotBoxHelper(type);
    const llvm = emitter.emitParts().join("\n");
    const body = llvm.match(new RegExp(`^define internal ptr @${helper}\\(.*?^}`, "ms"))![0];
    expect(body).toContain(
      `@scr_dyn_typed_ref_bind_native_object(ptr %result, ptr ${adapter.nativeObjectOps})`,
    );
    const recipe = llvm.split("\n").find((line) => line.startsWith("@sc_trr_"))!;
    expect(recipe).toContain(`ptr @scr_dyn_class_view_unavailable, ptr null, i32`);
    expect(body).toContain(`@scr_dyn_typed_ref_bind_class(ptr %result, ptr ${adapter.classOps})`);
    expect(recipe).toContain(`i32 3, ptr ${adapter.classOps}, ptr ${adapter.nativeObjectOps} }`);
    expect(recipe).toContain(`{ ptr, ptr, ptr, i${pointerBits}, ptr, ptr, i32, i32, ptr, ptr }`);
  },
);

test.each([32, 64] as const)(
  "record deletion stores ABSENT without conversion before releasing children on %s-bit targets",
  (pointerBits) => {
    const source = structuredClone(mod);
    const inline: IrType = { kind: "union", unionId: "inline" };
    const boxed: IrType = { kind: "union", unionId: "boxed" };
    const opaque: IrType = { kind: "union", unionId: "opaque" };
    source.unions!.push(
      { id: "inline", arms: [F64, UNDEFINED_T] },
      { id: "boxed", arms: [STRING, F64, UNDEFINED_T] },
      { id: "opaque", arms: [{ kind: "cryptoHash" }, UNDEFINED_T] },
    );
    source.records![0] = {
      id: "item",
      fields: [
        { name: "boxed", type: boxed },
        { name: "inline", type: inline },
        { name: "nullable", type: optional },
        { name: "opaque", type: opaque },
        { name: "required", type: F64 },
      ],
      declaredOrder: ["opaque", "nullable", "required", "inline", "boxed"],
    };
    defineProperty(source);
    expect(validateModule(source)).toEqual([]);
    const llvm = emitLlvmModule(source, { pointerBits });
    const apply = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal zeroext i1 @sc_native_0_apply("))!;
    const deletion = apply.match(/^native\.delete\d+:\n([\s\S]*?)^native\.convert\d+:/m)![1]!;
    expect(deletion).not.toMatch(
      /@sc_dc_|@scr_native_mutation_value|@scr_dyn_typed_ref_materialize/,
    );
    const fields = deletion.split(/^native\.delete\.field\d+:\n/m).slice(1);
    expect(fields).toHaveLength(5);
    expect(fields[2]).toContain("@scr_native_mutation_refuse");
    expect(fields[2]).not.toMatch(/store |getelementptr|@scr_native_mutation_finish/);
    const slots = [
      ...deletion.matchAll(/getelementptr inbounds %sc_rs_item, ptr %p, i64 0, i32 (\d+)/g),
    ];
    expect(slots.map((match) => match[1])).toEqual(["4", "3", "2", "1"]);
    for (const index of [0, 1, 3, 4]) {
      const field = fields[index]!;
      const admitted = field.indexOf("@scr_native_mutation_recheck");
      const address = field.indexOf("getelementptr inbounds %sc_rs_item");
      const stored = field.indexOf("store ");
      const finished = field.indexOf("@scr_native_mutation_finish");
      expect(address).toBeGreaterThan(admitted);
      expect(stored).toBeGreaterThan(address);
      expect(finished).toBeGreaterThan(stored);
      const release = field.search(/call void @(?:scr_|sc_).*release/);
      if (index === 3) expect(release).toBe(-1);
      else expect(release).toBeGreaterThan(finished);
    }
    expect(fields[0]).toMatch(/store ptr @sc_absent_\d+/);
    expect(fields[1]).toContain("store ptr @sc_nullable_absent");
    expect(fields[3]).toContain("getelementptr inbounds { i32, i64 }");
    expect(fields[4]).toMatch(/store ptr @sc_absent_\d+/);
    const conversion = apply.slice(apply.search(/^native\.convert\d+:/m));
    expect(conversion).not.toContain("; check cryptoHash");
    expect(conversion.match(/call (?:double|ptr) @sc_dc_/g)).toHaveLength(4);
  },
);

test.each([32, 64] as const)(
  "typed record stores finish metadata before releasing old children on %s-bit targets",
  (pointerBits) => {
    for (const operation of ["set", "define", "deleteSloppy", "keyed", "append"] as const) {
      const source = structuredClone(mod);
      const fieldType = operation === "append" ? STRING : optional;
      source.records![0] = { id: "item", fields: [{ name: "value", type: fieldType }] };
      const fn = source.functions[0]!;
      fn.params.push({ localId: "next", name: "next", type: fieldType });
      fn.locals.push({ id: "next", name: "next", type: fieldType, mutable: false });
      const next: IrExpr = { kind: "varRef", localId: "next", type: fieldType, loc };
      fn.body.push(
        operation === "keyed"
          ? {
              kind: "recordKeySet",
              obj: value,
              shapeId: "item",
              key: { kind: "strLit", value: "value", type: STRING, loc },
              value: next,
              loc,
            }
          : {
              kind: "recordSet",
              obj: value,
              shapeId: "item",
              field: "value",
              propertyOp: operation === "append" ? "set" : operation,
              value:
                operation === "deleteSloppy"
                  ? { kind: "fieldAbsent", unionId: "optional", type: optional, loc }
                  : operation === "append"
                    ? {
                        kind: "strConcat",
                        left: {
                          kind: "recordGet",
                          obj: value,
                          shapeId: "item",
                          field: "value",
                          type: STRING,
                          loc,
                        },
                        right: next,
                        type: STRING,
                        loc,
                      }
                    : next,
              loc,
            },
      );
      expect(validateModule(source)).toEqual([]);
      const llvm = emitLlvmModule(source, { pointerBits });
      const main = llvm
        .split(/^define /m)
        .find((fn) => /^internal [^\n]*@sc_b?f_main(?:\.i32)?\(/.test(fn))!;
      const finish = main.indexOf("@scr_native_object_finish_write");
      expect(finish, main).toBeGreaterThan(0);
      expect(main.match(/@scr_native_object_finish_write/g)).toHaveLength(1);
      const slot = main.lastIndexOf("getelementptr inbounds %sc_rs_item", finish);
      const stored = main.indexOf("store ptr", slot);
      expect(stored, main).toBeGreaterThan(slot);
      expect(finish).toBeGreaterThan(stored);
      const released = main.slice(stored).search(/call void @(?:scr_|sc_).*release/);
      expect(released, main).toBeGreaterThan(finish - stored);
      expect(main).not.toContain("@scr_native_property_forget");
      if (operation === "append") {
        const addresses = [...main.matchAll(/(%\w+) = getelementptr inbounds %sc_rs_item[^\n]*/g)];
        expect(addresses.length).toBeGreaterThan(0);
        for (const address of addresses)
          expect(main).not.toContain(`store ptr null, ptr ${address[1]}`);
      }
      const ordinal = operation === "define" ? 2 : operation === "deleteSloppy" ? 4 : 0;
      expect(main.slice(finish).split("\n")[0]).toContain(`i32 ${ordinal})`);
      // Remove the exposure root: ordinary unexposed stores need no metadata.
      fn.body.shift();
      const unexposed = emitLlvmModule(source, { pointerBits });
      expect(unexposed).not.toContain("@scr_native_object_finish_write");
    }
  },
);

test.each([32, 64] as const)(
  "typed Set passes exact lazy slot boxers on %s-bit targets",
  (pointerBits) => {
    const types: IrType[] = [
      F64,
      BOOL,
      STRING,
      { kind: "date" },
      optional,
      { kind: "union", unionId: "nullable" },
      { kind: "union", unionId: "inline" },
      { kind: "cryptoHash" },
    ];
    for (const type of types) {
      const source = structuredClone(mod);
      source.records![0] = { id: "item", fields: [{ name: "value", type }] };
      source.unions!.push(
        { id: "nullable", arms: [STRING, { kind: "nullT" }] },
        { id: "inline", arms: [F64, BOOL] },
      );
      const fn = source.functions[0]!;
      fn.params.push({ localId: "rhs", name: "rhs", type });
      fn.locals.push({ id: "rhs", name: "rhs", type, mutable: false });
      fn.body.push({
        kind: "recordSet",
        obj: value,
        shapeId: "item",
        field: "value",
        value: { kind: "varRef", localId: "rhs", type, loc },
        loc,
      });
      expect(validateModule(source)).toEqual([]);
      const llvm = emitLlvmModule(source, { pointerBits });
      const main = llvm
        .split(/^define /m)
        .find((body) => /^internal [^\n]*@sc_b?f_main(?:\.i32)?\(/.test(body))!;
      const call = main.match(
        /call zeroext i1 @scr_native_object_check_set\([^\n]+i64 (%\w+), ptr @(sc_slot_box_\d+), ptr @(sc_slot_box_\d+)\)/,
      )!;
      expect(call, main).not.toBeNull();
      const encoding =
        type.kind === "f64" || type.kind === "date"
          ? "bitcast double"
          : type.kind === "bool"
            ? "zext i1"
            : "ptrtoint ptr";
      expect(main).toContain(`${call[1]} = ${encoding}`);
      expect(main).not.toMatch(/call ptr @sc_slot_box_/);
      expect(main).not.toContain("@sc_dc_");
      expect(llvm).toContain(`define internal ptr @${call[2]}(i64 %slot)`);
      expect(llvm).toContain(`define internal ptr @${call[3]}(i64 %slot)`);
      if (type.kind === "cryptoHash") {
        const receiverBoxer = llvm.match(
          new RegExp(`^define internal ptr @${call[3]}\\(.*?^}`, "ms"),
        )![0];
        expect(receiverBoxer).toMatch(/ptr @sc_ldr_\d+_materialize, ptr null\)/);
        expect(receiverBoxer).toContain("@scr_dyn_typed_ref_bind_native_object");
        expect(llvm).not.toMatch(/; check cryptoHash/);
      }
      expect(main.indexOf("@scr_native_object_finish_write")).toBeGreaterThan(
        main.indexOf(call[0]),
      );
    }
  },
);

test.each([32, 64] as const)(
  "typed class Set uses lazy exact boxers and preserves declaration admission on %s-bit targets",
  (pointerBits) => {
    const types: IrType[] = [
      F64,
      BOOL,
      STRING,
      optional,
      { kind: "union", unionId: "nullable" },
      { kind: "union", unionId: "inline" },
      { kind: "union", unionId: "unit" },
      { kind: "cryptoHash" },
    ];
    for (const type of types) {
      const source = structuredClone(mod);
      const owner: IrType = { kind: "object", className: "Item" };
      const item: IrExpr = { kind: "varRef", localId: "item", type: owner, loc };
      const rhs: IrExpr = { kind: "varRef", localId: "rhs", type, loc };
      source.records = [];
      source.unions!.push(
        { id: "nullable", arms: [STRING, { kind: "nullT" }] },
        { id: "inline", arms: [F64, BOOL] },
        { id: "unit", arms: [UNDEFINED_T, { kind: "nullT" }] },
      );
      source.classes = [
        {
          name: "Item",
          tracksOwnFields: true,
          nativePropertyBagHelper: "prepare.Item",
          fields: [
            { name: "value", type },
            { name: DYN_CLASS_PROPERTIES, type: DYN, visibility: "internal" },
          ],
          loc,
        },
      ];
      const guard: IrExpr & { kind: "intrinsic" } = {
        kind: "intrinsic",
        name: "native.checkWrite",
        args: [
          item,
          { kind: "strLit", value: "value", type: STRING, loc },
          { kind: "numLit", value: 1, type: F64, loc },
          rhs,
        ],
        type: BOOL,
        loc,
      };
      source.functions = [
        {
          name: "main",
          params: [
            { localId: "item", name: "item", type: owner },
            { localId: "rhs", name: "rhs", type },
          ],
          locals: [
            { id: "item", name: "item", type: owner, mutable: false },
            { id: "rhs", name: "rhs", type, mutable: false },
          ],
          returnType: VOID,
          loc,
          body: [
            {
              kind: "exprStmt",
              expr: { kind: "intrinsic", name: "native.isFrozen", args: [item], type: BOOL, loc },
              loc,
            },
            {
              kind: "if",
              cond: guard,
              // oxlint-disable-next-line unicorn/no-thenable -- An IR branch contains statements.
              then: [
                {
                  kind: "fieldSet",
                  obj: item,
                  className: "Item",
                  field: "value",
                  value: rhs,
                  propertyOp: "setSloppy",
                  loc,
                },
              ],
              else_: null,
              loc,
            },
          ],
        },
        {
          name: "prepare.Item",
          params: [{ localId: "item", name: "item", type: owner }],
          locals: [{ id: "item", name: "item", type: owner, mutable: false }],
          returnType: DYN,
          loc,
          body: [{ kind: "return", value: { kind: "dynObjLit", fields: [], type: DYN, loc }, loc }],
        },
      ];
      expect(validateModule(source)).toEqual([]);
      const llvm = emitLlvmModule(source, { pointerBits });
      const main = llvm
        .split(/^define /m)
        .find((body) => /^internal [^\n]*@sc_b?f_main(?:\.i32)?\(/.test(body))!;
      const call = main.match(
        /call zeroext i1 @scr_native_object_check_set\([^\n]+i32 1, i64 (%\w+), ptr @(sc_slot_box_\d+), ptr @(sc_slot_box_\d+)\)/,
      )!;
      expect(call, main).not.toBeNull();
      expect(main).not.toMatch(/call ptr @sc_slot_box_|@scr_dyn_typed_ref_materialize|@sc_dc_/);
      const finish = main.indexOf("@scr_native_object_finish_write");
      const slot = main.lastIndexOf("getelementptr inbounds %sc_o_Item", finish);
      const stored = main.indexOf("store ", slot);
      expect(stored, main).toBeGreaterThan(main.indexOf(call[0]));
      expect(finish).toBeGreaterThan(stored);
      const release = main.slice(stored).search(/call void @(?:scr_|sc_).*release/);
      if (release >= 0) expect(release).toBeGreaterThan(finish - stored);
      expect(llvm).toContain(`define internal ptr @${call[2]}(i64 %slot)`);
      expect(llvm).toContain(`define internal ptr @${call[3]}(i64 %slot)`);
      // The same constructor-style declaration stays a direct Define guard.
      const restored = deserializeModule(serializeModule(source));
      expect(restored).toEqual(source);
      expect(validateModule(restored)).toEqual([]);
      guard.args = guard.args.slice(0, 3);
      expect(validateModule(source)).not.toEqual([]);
      guard.args[2] = { kind: "numLit", value: 2, type: F64, loc };
      const branch = source.functions[0]!.body[1]!;
      if (branch.kind !== "if" || branch.then[0]?.kind !== "fieldSet")
        throw new Error("expected field Set");
      branch.then[0].propertyOp = "define";
      expect(validateModule(source)).toEqual([]);
      const define = emitLlvmModule(source, { pointerBits });
      expect(define).toContain("@scr_native_object_check_write(");
      expect(define).not.toContain("@scr_native_object_check_set(");
      guard.args.push(rhs);
      expect(validateModule(source)).not.toEqual([]);
    }
  },
);

test("native stores branch on admission after RHS evaluation", () => {
  const source: IrModule = {
    ...mod,
    functions: mod.functions.map((fn) => ({
      ...fn,
      body: [
        ...fn.body,
        {
          kind: "recordSet",
          obj: value,
          shapeId: "item",
          field: "%x",
          value: { kind: "call", callee: "next", args: [], type: F64, loc },
          propertyOp: "setSloppy",
          loc,
        },
      ],
    })),
  };
  source.functions.push({
    name: "next",
    params: [],
    locals: [],
    returnType: F64,
    loc,
    body: [{ kind: "return", value: { kind: "numLit", value: 2, type: F64, loc }, loc }],
  });
  const llvm = emitLlvmModule(source);
  const main = llvm
    .split(/^define /m)
    .find((fn) => /^internal [^\n]*@sc_b?f_main(?:\.i32)?\(/.test(fn))!;
  const rhs = main.search(/call [^\n]*@sc_b?f_next(?:\.i32)?\(/);
  const guard = main.indexOf("@scr_native_object_check_set(");
  expect(rhs, main).toBeGreaterThanOrEqual(0);
  expect(guard, main).toBeGreaterThan(rhs);
  expect(main).toMatch(
    /call zeroext i1 @scr_native_object_check_set\([^\n]+i32 1, i64 %\w+, ptr @sc_slot_box_\d+, ptr @sc_slot_box_\d+\)/,
  );
  expect(main).toMatch(/br i1 %\w+, label %if\.t\w*, label %if\./);
});

test.each([32, 64] as const)(
  "class definitions preserve physical ownership and per-key commits on %s-bit targets",
  (pointerBits) => {
    const source = structuredClone(mod);
    const type: IrType = { kind: "object", className: "Item" };
    const item: IrExpr = { kind: "varRef", localId: "item", type, loc };
    const keys: IrType = { kind: "set", elem: { kind: "union", unionId: "boxedChild" } };
    source.records = [];
    source.unions!.push(
      { id: "scalar", arms: [F64, UNDEFINED_T] },
      { id: "child", arms: [{ kind: "object", className: "Child" }, UNDEFINED_T] },
      { id: "boxedChild", arms: [{ kind: "object", className: "Child" }, UNDEFINED_T] },
    );
    source.classes = [
      { name: "Child", fields: [], loc },
      {
        name: "Item",
        fields: [
          { name: "flag", type: BOOL },
          { name: "scalar", type: { kind: "union", unionId: "scalar" } },
          { name: "child", type: { kind: "union", unionId: "child" } },
          { name: "boxedChild", type: { kind: "union", unionId: "boxedChild" } },
          { name: "optional", type: optional },
          { name: "text", type: STRING },
          { name: "value", type: F64 },
          { name: "count", type: F64 },
          { name: "hash", type: { kind: "cryptoHash" } },
          { name: DYN_CLASS_PROPERTIES, type: DYN, visibility: "internal" },
        ],
        tracksOwnFields: true,
        nativePropertyBagHelper: "prepare.Item",
        loc,
      },
    ];
    const params = [{ localId: "item", name: "item", type }];
    const locals = [{ id: "item", name: "item", type, mutable: false }];
    source.functions = [
      {
        name: "main",
        params: [...params, { localId: "keys", name: "keys", type: keys }],
        locals: [...locals, { id: "keys", name: "keys", type: keys, mutable: false }],
        returnType: VOID,
        loc,
        body: [
          {
            kind: "exprStmt",
            expr: { kind: "intrinsic", name: "native.isFrozen", args: [item], type: BOOL, loc },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "fieldGet",
              obj: item,
              className: "Item",
              field: "count",
              type: F64,
              loc,
            },
            loc,
          },
        ],
      },
      {
        name: "%Item.constructor",
        params,
        locals,
        returnType: VOID,
        loc,
        body: [
          {
            kind: "fieldSet",
            obj: item,
            className: "Item",
            field: "count",
            value: { kind: "numLit", value: 1, type: F64, loc },
            loc,
          },
        ],
      },
      {
        name: "prepare.Item",
        params,
        locals,
        returnType: DYN,
        loc,
        body: [
          {
            kind: "return",
            value: {
              kind: "fieldGet",
              obj: item,
              className: "Item",
              field: DYN_CLASS_PROPERTIES,
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      },
    ];
    expect(validateModule(source)).toEqual([]);
    expect(emitLlvmModule(source, { pointerBits })).not.toContain("@sc_native_0_apply");
    // A literal-keyed write leaves count provably int32. DefineProperty is
    // conservatively an arbitrary dynamic write and disqualifies every field.
    source.functions[0]!.body.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySet",
        type: VOID,
        loc,
        args: [
          { kind: "dynFrom", value: item, type: DYN, loc },
          { kind: "strLit", value: "value", type: STRING, loc },
          { kind: "dynFrom", value: { kind: "numLit", value: 7, type: F64, loc }, type: DYN, loc },
        ],
      },
      loc,
    });
    expect(validateModule(source)).toEqual([]);
    const emitter = new LlEmitter(source, { pointerBits });
    expect(emitter.nullableUnions.has("child")).toBe(true);
    expect(emitter.nullableUnions.has("boxedChild")).toBe(false);
    expect(emitter.nullableFields.get("Item", "boxedChild")).not.toBeNull();
    expect(emitter.int32Slots.isField("Item", "count")).toBe(true);
    const llvm = emitter.emitParts().join("\n");
    const apply = llvm
      .split(/^define /m)
      .find((fn) => fn.startsWith("internal zeroext i1 @sc_native_0_apply("))!;
    expect(apply).toBeDefined();
    expect(apply).not.toMatch(/@(scr_dyn_typed_ref_materialize|sc_ldr_|sc_tr_commit)/);
    expect(apply.match(/call (?:zeroext i1|double|ptr) @sc_dc_/g)).toHaveLength(8);
    expect(llvm).not.toContain("; check cryptoHash");
    const deletion = apply.match(/^native\.delete\d+:\n([\s\S]*?)^native\.convert\d+:/m)![1]!;
    expect(deletion).toMatch(/br label %native\.attributes/);
    expect(deletion).not.toMatch(/getelementptr|load |store |release|@sc_dc_/);
    const blocks = apply.split(/native\.apply\.field\d*:\n/).slice(1);
    expect(blocks).toHaveLength(9);
    for (const block of blocks.slice(0, 8)) {
      const recheck = block.indexOf("@scr_native_mutation_recheck");
      const address = block.indexOf("getelementptr inbounds %sc_o_Item");
      expect(recheck).toBeGreaterThan(block.indexOf("@sc_dc_"));
      expect(address, block).toBeGreaterThan(recheck);
      const store = block.slice(address),
        finish = store.indexOf("@scr_native_mutation_finish");
      expect(finish).toBeGreaterThan(store.indexOf("store "));
      const release = store.search(/call void @(?:scr_|sc_).*release/);
      if (release >= 0) expect(release).toBeGreaterThan(finish);
    }
    expect(blocks[2]).not.toContain("getelementptr inbounds %ScrUnion");
    expect(blocks[3]).toContain("getelementptr inbounds %ScrUnion");
    expect(blocks[3]).toContain("@scr_union_release");
    expect(blocks[1]).toContain("getelementptr inbounds { i32, i64 }");
    expect(blocks[0]).toMatch(/zext i1 %\w+ to i8/);
    expect(blocks[7]).toContain("@llvm.fptosi.sat.i32.f64");
    expect(blocks[7]).toContain("@llvm.trap()");
    expect(llvm).toMatch(/ptr @sc_native_0_read, ptr @sc_native_0_apply, ptr null \}/);
    for (const field of source.classes![1]!.fields.slice(0, 8)) {
      const next: IrExpr =
        field.name === "count"
          ? { kind: "numLit", value: 2, type: F64, loc }
          : { kind: "varRef", localId: "next", type: field.type, loc };
      source.functions.push({
        name: `write.${field.name}`,
        params: [...params, { localId: "next", name: "next", type: field.type }],
        locals: [...locals, { id: "next", name: "next", type: field.type, mutable: false }],
        returnType: VOID,
        loc,
        body: [
          {
            kind: "fieldSet",
            obj: item,
            className: "Item",
            field: field.name,
            value:
              field.name === "text"
                ? {
                    kind: "strConcat",
                    left: {
                      kind: "fieldGet",
                      obj: item,
                      className: "Item",
                      field: field.name,
                      type: STRING,
                      loc,
                    },
                    right: next,
                    type: STRING,
                    loc,
                  }
                : next,
            propertyOp: field.name === "flag" ? "define" : "set",
            loc,
          },
        ],
      });
    }
    expect(validateModule(source)).toEqual([]);
    const stored = emitLlvmModule(source, { pointerBits });
    const writes = stored
      .split(/^define /m)
      .filter((fn) => /@sc_b?f_write_.*\{ ; write\./.test(fn.split("\n")[0]!));
    expect(writes).toHaveLength(8);
    for (const write of writes) {
      const finish = write.indexOf("@scr_native_object_finish_write");
      expect(finish, write).toBeGreaterThan(0);
      expect(write.match(/@scr_native_object_finish_write/g)).toHaveLength(1);
      const slot = write.lastIndexOf("getelementptr inbounds %sc_o_Item", finish);
      const store = write.indexOf("store ", slot);
      expect(store, write).toBeGreaterThan(slot);
      expect(finish).toBeGreaterThan(store);
      const release = write.slice(store).search(/call void @(?:scr_|sc_).*release/);
      if (release >= 0) expect(release, write).toBeGreaterThan(finish - store);
      for (const address of write.matchAll(/(%\w+) = getelementptr inbounds %sc_o_Item[^\n]*/g))
        expect(write).not.toContain(`store ptr null, ptr ${address[1]}`);
    }
  },
);

test.each([32, 64] as const)(
  "class facts peek raw bags and dispatch exact layouts on %s-bit targets",
  (pointerBits) => {
    const baseFields: IrClassField[] = [
      { name: "#public", type: F64 },
      { name: "%public", type: F64 },
      { name: "#secret", type: F64, visibility: "private" },
      { name: DYN_CLASS_PROPERTIES, type: DYN, visibility: "internal" },
    ];
    const base: IrType = { kind: "object", className: "Base" };
    const source: IrModule = {
      irVersion: 17,
      sourceFile: loc.file,
      entry: "main",
      classes: [
        {
          name: "Base",
          fields: baseFields,
          tracksOwnFields: true,
          nativePropertyBagHelper: "prepare.Base",
          loc,
        },
        {
          name: "TypeOnly",
          base: "Base",
          fields: baseFields,
          tracksOwnFields: true,
          loc,
        },
        {
          name: "Child",
          base: "TypeOnly",
          fields: [...baseFields, { name: "child", type: F64 }],
          tracksOwnFields: true,
          nativePropertyBagHelper: "prepare.Child",
          loc,
        },
      ],
      functions: [
        {
          name: "main",
          params: [{ localId: "item", name: "item", type: base }],
          locals: [{ id: "item", name: "item", type: base, mutable: false }],
          returnType: VOID,
          loc,
          body: [
            {
              kind: "exprStmt",
              expr: {
                kind: "intrinsic",
                name: "native.isFrozen",
                args: [{ kind: "varRef", localId: "item", type: base, loc }],
                type: BOOL,
                loc,
              },
              loc,
            },
          ],
        },
      ],
    };
    for (const cls of source.classes!) {
      if (!cls.nativePropertyBagHelper) continue;
      cls.prototypeDataHelper = `prototype.${cls.name}`;
      source.functions.push({
        name: cls.prototypeDataHelper,
        params: [],
        locals: [],
        returnType: DYN,
        body: [{ kind: "return", value: { kind: "dynObjLit", fields: [], type: DYN, loc }, loc }],
        loc,
      });
      const type: IrType = { kind: "object", className: cls.name };
      const receiver: IrExpr = { kind: "varRef", localId: "item", type, loc };
      source.functions.push({
        name: `%${cls.name}.constructor`,
        params: [{ localId: "item", name: "item", type }],
        locals: [{ id: "item", name: "item", type, mutable: false }],
        returnType: VOID,
        body: [],
        loc,
      });
      source.functions.push({
        name: cls.nativePropertyBagHelper!,
        params: [{ localId: "item", name: "item", type }],
        locals: [{ id: "item", name: "item", type, mutable: false }],
        returnType: DYN,
        loc,
        body: [
          {
            kind: "fieldSet",
            className: cls.name,
            obj: receiver,
            field: DYN_CLASS_PROPERTIES,
            value: { kind: "dynObjLit", fields: [], type: DYN, loc },
            loc,
          },
          {
            kind: "return",
            value: {
              kind: "fieldGet",
              obj: receiver,
              className: cls.name,
              field: DYN_CLASS_PROPERTIES,
              type: DYN,
              loc,
            },
            loc,
          },
        ],
      });
    }
    expect(validateModule(source)).toEqual([]);
    const llvm = emitLlvmModule(source, { pointerBits });
    // Callback tables follow definitions and must not enter body assertions.
    const functions = (llvm.match(/^define [^]*?^}/gm) ?? []).map((fn) =>
      fn.slice("define ".length),
    );
    const facts = functions.filter((fn) => /^internal i32 @sc_native_\d+_facts\(/.test(fn));
    expect(facts).toHaveLength(2);
    for (const fn of facts) {
      expect(fn).toContain("@scr_native_property_bag_facts");
      expect(fn).not.toMatch(/@(scr_dyn_obj_get|scr_dyn_get|sc_f_|sc_native_\d+_prepare)/);
    }
    expect(llvm).toContain(
      `@sc_native_0_lengths = internal constant [2 x i${pointerBits}] [i${pointerBits} 7, i${pointerBits} 7]`,
    );
    expect(llvm).toContain(
      `@sc_native_1_lengths = internal constant [3 x i${pointerBits}] [i${pointerBits} 7, i${pointerBits} 7, i${pointerBits} 5]`,
    );
    const exact = functions.find((fn) => fn.startsWith("internal ptr @sc_native_0_exact("))!;
    expect(exact).toContain("ret ptr @sc_native_1_ops");
    const prototypes = functions.filter((fn) =>
      /^internal ptr @sc_native_\d+_prototype\(/.test(fn),
    );
    expect(prototypes).toHaveLength(2);
    for (const prototype of prototypes) {
      expect(prototype).toContain("call ptr @sc_f_");
      expect(prototype).not.toMatch(/@(sc_native_\d+_prepare|scr_dyn_typed_ref_materialize)/);
      expect(prototype).not.toContain("store ");
    }
    const reads = functions.filter((fn) => /^internal ptr @sc_native_\d+_read\(/.test(fn));
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read).toMatch(/@sc_native_\d+_facts/);
      expect(read).not.toMatch(/@(scr_dyn_call|scr_dyn_typed_ref_materialize|sc_ldr_)/);
      expect(read).not.toMatch(/getelementptr[^\n]+i32 4\b/); // private #secret slot
      expect(read).not.toMatch(/getelementptr[^\n]+i32 5\b/); // internal bag slot
    }
    const prepare = functions.find((fn) =>
      fn.startsWith("internal zeroext i1 @sc_native_0_prepare("),
    )!;
    expect(prepare).toContain("@scr_exc_pending()");
    expect(prepare).not.toContain("@scr_exc_clear");
    const installation = functions.find((fn) =>
      fn.includes("call void @scr_native_object_sync_properties("),
    )!;
    const sync = installation.indexOf("call void @scr_native_object_sync_properties(");
    expect(installation.indexOf("store ptr", sync)).toBeGreaterThan(sync);
    defineProperty(source);
    const writable = emitLlvmModule(source, { pointerBits });
    expect(writable.match(/^define internal zeroext i1 @sc_native_\d+_apply\(/gm)).toHaveLength(2);
    expect(writable).toMatch(
      /ptr @sc_native_1_read, ptr @sc_native_1_apply, ptr @sc_native_1_prototype \}/,
    );
  },
);
