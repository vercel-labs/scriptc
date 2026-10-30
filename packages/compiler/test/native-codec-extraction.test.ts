import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { LlEmitter } from "../src/backend/llvm/emitter.js";
import { releaseSym, typedRefConstructor, vAdapters } from "../src/backend/llvm/shapes.js";
import { mangleRecordNew, mangleRecordStruct } from "../src/backend/mangle.js";
import { compileC, resolveCc, runtimeSrcDir } from "../src/backend/native-toolchain.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  UNDEFINED_T,
  VOID,
  type IrModule,
  type IrType,
} from "../src/ir/ir.js";

const exec = promisify(execFile);

test("native codec unions preserve identity, tags and exceptions without structural reconstruction", async () => {
  const loc = { file: "codec-extraction.ts", start: 0, end: 0 };
  const encoder: IrType = { kind: "record", shapeId: "encoder" };
  const decoder: IrType = { kind: "record", shapeId: "decoder" };
  const ordinary: IrType = { kind: "record", shapeId: "ordinary" };
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
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    ffiImports: [{ name: "probe", symbol: "codec_probe", params: [], returns: "void" }],
    functions: [
      {
        name: "main",
        params: [],
        locals: [],
        returnType: VOID,
        loc,
        body: [
          {
            kind: "exprStmt",
            expr: { kind: "ffiCall", import: "probe", args: [], type: VOID, loc },
            loc,
          },
        ],
      },
    ],
    records: [
      { id: "encoder", fields: [{ name: "%TextEncoder", type: F64 }] },
      {
        id: "decoder",
        fields: [
          { name: "%TextDecoder", type: F64 },
          { name: "%state", type: DYN },
        ],
      },
      {
        id: "ordinary",
        fields: [
          { name: "kind", type: STRING },
          { name: "value", type: F64 },
        ],
      },
      {
        id: "partial",
        fields: [
          { name: "held", type: STRING },
          { name: "kind", type: STRING },
        ],
      },
    ],
    unions: [
      ...variants.map((arms, index) => ({ id: `codec${index}`, arms })),
      {
        id: "ordinaryChoice",
        arms: [ordinary, F64],
        discriminant: { field: "kind", cases: [{ tag: 0, values: ["view"] }] },
      },
    ],
  };
  const emitter = new LlEmitter(mod, { pointerBits: 64 });
  const wrappers: string[] = [];
  const declarations: string[] = [];
  const exposeSlot = (name: string, type: IrType): void => {
    const unbox = emitter.dyn.nativeSlotUnboxHelper(type);
    wrappers.push(
      `define zeroext i1 @probe_unbox_${name}(ptr %d, ptr %out) { %r = call zeroext i1 @${unbox}(ptr %d, ptr %out)\n ret i1 %r }`,
    );
    declarations.push(`extern bool probe_unbox_${name}(ScrDyn *, uint64_t *);`);
  };
  const expose = (name: string, type: IrType): void => {
    exposeSlot(name, type);
    const match = emitter.dyn.dynMatchHelper(type);
    const build = emitter.dyn.dynCheckHelper(type);
    wrappers.push(
      `define zeroext i1 @probe_match_${name}(ptr %d) { %r = call zeroext i1 @${match}(ptr %d)\n ret i1 %r }`,
      `define ptr @probe_build_${name}(ptr %d) { %r = call ptr @${build}(ptr %d, ptr null)\n ret ptr %r }`,
      `define void @probe_release_${name}(ptr %p) { call void ${releaseSym(emitter, type)}(ptr %p)\n ret void }`,
    );
    declarations.push(
      `extern bool probe_match_${name}(ScrDyn *); extern void *probe_build_${name}(ScrDyn *); extern void probe_release_${name}(void *);`,
    );
  };
  variants.forEach((_, index) =>
    expose(String(index), { kind: "union", unionId: `codec${index}` }),
  );
  expose("nested", { kind: "array", elem: { kind: "union", unionId: "codec0" } });
  expose("ordinary", { kind: "union", unionId: "ordinaryChoice" });
  expose("plain", { kind: "record", shapeId: "partial" });
  exposeSlot("number", F64);
  exposeSlot("boolean", BOOL);

  const capsuleConstructors = [encoder, decoder, ordinary].map((type) => {
    if (type.kind !== "record") throw new Error("expected record fixture");
    const name = type.shapeId;
    const rc = vAdapters(emitter, type);
    // Use generated allocation and RC: decoder records may have collector
    // headers, and their private fields must never be fabricated by C casts.
    wrappers.push(
      `define ptr @probe_new_${name}() { %p = call ptr @${mangleRecordNew(name)}()\n ret ptr %p }`,
      `define ptr @probe_retain_${name}(ptr %p) { %r = call ptr ${rc.retain}(ptr %p)\n ret ptr %r }`,
      `define void @probe_drop_${name}(ptr %p) { call void ${rc.release}(ptr %p)\n ret void }`,
    );
    declarations.push(
      `extern void *probe_new_${name}(void); extern void *probe_retain_${name}(void *); extern void probe_drop_${name}(void *);`,
    );
    return typedRefConstructor(emitter, type).slice(1);
  });
  const nativeKind = emitter.internLiteral("native");
  wrappers.push(`define void @probe_set_native_kind(ptr %p) {
    %field = getelementptr inbounds %${mangleRecordStruct("ordinary")}, ptr %p, i64 0, i32 1
    store ptr ${nativeKind}, ptr %field
    ret void
  }`);
  const rows = variants.flatMap((arms, index) =>
    arms.flatMap((arm, tag) => {
      const codec = arm === encoder ? 0 : arm === decoder ? 1 : -1;
      if (codec < 0) return [];
      return [
        `{probe_match_${index}, probe_build_${index}, probe_release_${index}, probe_unbox_${index}, ${codec}, ${tag}, ${emitter.nullableUnions.has(`codec${index}`) ? "true" : "false"}}`,
      ];
    }),
  );
  const controls = variants.flatMap((arms, index) =>
    arms.flatMap((arm, tag) => {
      const input =
        arm.kind === "f64" ? 0 : arm.kind === "string" ? 1 : arm.kind === "undefinedT" ? 2 : -1;
      return input < 0
        ? []
        : [
            `{probe_match_${index}, probe_build_${index}, probe_release_${index}, probe_unbox_${index}, ${input}, ${tag}, ${emitter.nullableUnions.has(`codec${index}`) ? "true" : "false"}}`,
          ];
    }),
  );
  const fixture = `#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
${declarations.join("\n")}
extern void probe_set_native_kind(void *);
static ScrDyn *marker;
static unsigned materializations, getter_calls, getter_throw_after;
static const char *view_kind = "view";
static bool getter_throws;
static ScrDyn *new_string(const char *value) {
  ScrStr *text = scr_str_new(value, strlen(value));
  ScrDyn *boxed = scr_dyn_new_str(text);
  scr_str_release(text);
  return boxed;
}
static void throw_marker(void) {
  scr_throw_ref(scr_dyn_retain(marker), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}
static void take_marker(void) {
  assert(scr_exc_pending());
  ScrCaught *caught = scr_exc_take();
  assert(caught->payload == marker);
  scr_caught_release(caught);
  assert(!scr_exc_pending());
}
static ScrDyn *refusing_view(void *ptr) {
  (void)ptr;
  materializations++;
  throw_marker();
  return scr_dyn_new_obj(); /* owned even when materialization throws */
}
static ScrDyn *read_kind(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  getter_calls++;
  if (getter_throws || (getter_throw_after && getter_calls >= getter_throw_after)) {
    throw_marker();
    return scr_dyn_retain(scr_dyn_undefined());
  }
  return new_string(view_kind);
}
static ScrDyn *ordinary_view(void *ptr) {
  (void)ptr;
  ScrDyn *view = scr_dyn_new_obj();
  view->copied_from_native = true;
  scr_dyn_obj_set(view, "kind", 4, scr_dyn_retain(scr_dyn_undefined()));
  ScrDynEntry *entry = &view->v.obj.entries[0];
  entry->accessor = true;
  entry->getter = scr_dyn_new_func(scr_closure_new(NULL, 0), read_kind, 0, "func()=>dyn", "kind");
  scr_dyn_obj_set(view, "value", 5, scr_dyn_new_num(4));
  return view;
}
typedef struct {
  bool (*match)(ScrDyn *);
  void *(*build)(ScrDyn *);
  void (*release)(void *);
  bool (*unbox)(ScrDyn *, uint64_t *);
  unsigned input, tag;
  bool nullable;
} Case;
static const Case cases[] = {${rows.join(",\n")}};
static const Case controls[] = {${controls.join(",\n")}};
void codec_probe(void) {
  marker = scr_dyn_new_obj();
  void *native[] = {probe_new_encoder(), probe_new_decoder()};
  ScrDyn *capsules[] = {
    ${capsuleConstructors[0]}(native[0], probe_retain_encoder, probe_drop_encoder, "record:encoder", 14, refusing_view, NULL),
    ${capsuleConstructors[1]}(native[1], probe_retain_decoder, probe_drop_decoder, "record:decoder", 14, refusing_view, NULL),
  };
  const uint64_t untouched = UINT64_C(0xa5a5a5a5a5a5a5a5);
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    const Case *row = &cases[i];
    assert(row->match(capsules[row->input]));
    assert(!scr_exc_pending() && materializations == 0);
    void *result = row->build(capsules[row->input]);
    assert(result && !scr_exc_pending() && materializations == 0);
    if (row->nullable) assert(result == native[row->input]);
    else {
      ScrUnion *box = result;
      assert(box->tag == row->tag && scr_union_peek(box) == native[row->input]);
    }
    row->release(result);
    uint64_t slot = untouched;
    assert(row->unbox(capsules[row->input], &slot));
    assert(!scr_exc_pending() && materializations == 0);
    result = (void *)(uintptr_t)slot;
    if (row->nullable) assert(result == native[row->input]);
    else {
      ScrUnion *box = result;
      assert(box->tag == row->tag && scr_union_peek(box) == native[row->input]);
    }
    row->release(result);
    assert(row->match(capsules[row->input]));
    slot = untouched;
    assert(!row->unbox(NULL, &slot) && slot == untouched);
    ScrDyn *mismatch = scr_dyn_new_bool(false);
    assert(!row->unbox(mismatch, &slot) && slot == untouched && !scr_exc_pending());
    scr_dyn_release(mismatch);
    throw_marker();
    assert(!row->unbox(capsules[row->input], &slot) && slot == untouched);
    take_marker();
  }
  for (size_t i = 0; i < sizeof controls / sizeof controls[0]; i++) {
    const Case *row = &controls[i];
    ScrDyn *source = row->input == 0 ? scr_dyn_new_num(7) : row->input == 1
        ? new_string("value") : scr_dyn_retain(scr_dyn_undefined());
    assert(row->match(source) && !scr_exc_pending());
    void *result = row->build(source);
    assert(!scr_exc_pending() && materializations == 0);
    if (row->nullable) assert(row->input == 2 && result == NULL);
    else {
      assert(result && ((ScrUnion *)result)->tag == row->tag);
      if (row->input == 0) assert(scr_union_get_f64(result) == 7);
      if (row->input == 1) {
        ScrStr *value = scr_union_peek(result);
        assert(value->len == 5 && memcmp(value->data, "value", 5) == 0);
      }
    }
    row->release(result);
    uint64_t slot = untouched;
    assert(row->unbox(source, &slot) && !scr_exc_pending());
    result = (void *)(uintptr_t)slot;
    if (row->nullable) assert(slot == 0);
    else {
      assert(result && ((ScrUnion *)result)->tag == row->tag);
      if (row->input == 0) assert(scr_union_get_f64(result) == 7);
      if (row->input == 1) {
        ScrStr *value = scr_union_peek(result);
        assert(value->len == 5 && memcmp(value->data, "value", 5) == 0);
      }
    }
    row->release(result);
    scr_dyn_release(source);
  }
  uint64_t scalar = untouched;
  ScrDyn *zero = scr_dyn_new_num(0);
  assert(probe_unbox_number(zero, &scalar) && scalar == 0 && !scr_exc_pending());
  scr_dyn_release(zero);
  scalar = untouched;
  ScrDyn *negative_zero = scr_dyn_new_num(-0.0);
  assert(probe_unbox_number(negative_zero, &scalar) && scalar == UINT64_C(0x8000000000000000));
  scr_dyn_release(negative_zero);
  scalar = untouched;
  ScrDyn *no = scr_dyn_new_bool(false);
  assert(probe_unbox_boolean(no, &scalar) && scalar == 0 && !scr_exc_pending());
  scr_dyn_release(no);
  for (unsigned source_first = 0; source_first < 2; source_first++) {
   for (unsigned extract = 0; extract < 2; extract++) {
    ScrDyn *source = scr_dyn_new_arr();
    scr_dyn_arr_push(source, scr_dyn_retain(capsules[0]));
    assert(probe_match_nested(source));
    uint64_t slot = untouched;
    ScrArr *result;
    if (extract) {
      assert(probe_unbox_nested(source, &slot));
      result = (ScrArr *)(uintptr_t)slot;
    } else result = probe_build_nested(source);
    assert(result && !scr_exc_pending() && materializations == 0);
    void *element = scr_arr_get_ref(result, 0);
    assert(element == native[0]);
    probe_release_0(element);
    if (source_first) { scr_dyn_release(source); scr_arr_release(result); }
    else { scr_arr_release(result); scr_dyn_release(source); }
    assert(probe_match_0(capsules[0]));
   }
  }
  ScrDyn *wrong = ${capsuleConstructors[0]}(native[0], probe_retain_encoder, probe_drop_encoder,
      "record:unrelated", 16, refusing_view, NULL);
  uint64_t rejected = untouched;
  assert(!probe_unbox_0(wrong, &rejected) && rejected == untouched);
  assert(materializations == 0 && getter_calls == 0 && !scr_exc_pending());
  assert(!probe_match_0(wrong));
  assert(materializations == 1 && getter_calls == 0);
  take_marker();
  assert(probe_build_0(wrong) == NULL);
  assert(materializations == 2 && getter_calls == 0);
  take_marker();
  scr_dyn_release(wrong);

  ScrDyn *plain_source = ordinary_view(NULL);
  scr_dyn_obj_set(plain_source, "held", 4, new_string("retained before the throwing getter"));
  getter_calls = 0;
  getter_throw_after = 2; /* builder already owns held when kind throws */
  assert(!probe_unbox_plain(plain_source, &rejected) && rejected == untouched);
  assert(getter_calls == 2);
  take_marker();
  getter_throw_after = 0;
  assert(probe_unbox_plain(plain_source, &rejected) && !scr_exc_pending());
  probe_release_plain((void *)(uintptr_t)rejected);
  scr_dyn_release(plain_source);

  void *plain = probe_new_ordinary();
  probe_set_native_kind(plain);
  ScrDyn *capsule = ${capsuleConstructors[2]}(plain, probe_retain_ordinary, probe_drop_ordinary,
      "record:ordinary", 15, ordinary_view, NULL);
  ScrDyn *cached = scr_dyn_typed_ref_materialize(capsule);
  assert(probe_match_ordinary(capsule) && !scr_exc_pending());
  void *selected = probe_build_ordinary(capsule);
  assert(selected && !scr_exc_pending());
  assert(((ScrUnion *)selected)->tag == 0 && scr_union_peek(selected) == plain);
  probe_release_ordinary(selected);
  assert(getter_calls > 0);
  view_kind = "other";
  assert(!probe_match_ordinary(capsule) && !scr_exc_pending());
  ScrDyn *refreshed = scr_dyn_typed_ref_materialize(capsule);
  assert(refreshed == cached);
  scr_dyn_release(refreshed);
  getter_throws = true;
  assert(!probe_match_ordinary(capsule));
  take_marker();
  assert(probe_build_ordinary(capsule) == NULL);
  take_marker();
  scr_dyn_release(cached);
  scr_dyn_release(capsule);
  probe_drop_ordinary(plain);
  scr_dyn_release(capsules[0]);
  scr_dyn_release(capsules[1]);
  probe_drop_encoder(native[0]);
  probe_drop_decoder(native[1]);
  scr_dyn_release(marker);
  marker = NULL;
  puts("codec identity, tags, ownership and exceptions preserved");
}
`;
  const dir = await mkdtemp(join(tmpdir(), "scriptc-codec-extraction-"));
  try {
    const source = join(dir, "probe.c");
    const object = join(dir, "probe.o");
    const program = join(dir, "program.ll");
    const executable = join(dir, "program");
    await writeFile(source, fixture);
    await writeFile(program, emitter.emitParts().join("\n") + "\n" + wrappers.join("\n"));
    const driver = resolveCc();
    await exec(driver.argv[0]!, [
      ...driver.argv.slice(1),
      ...driver.targetArgs,
      "-std=c11",
      "-O1",
      "-fsanitize=address",
      "-DSCR_RC_AUDIT",
      "-I",
      runtimeSrcDir(),
      "-c",
      source,
      "-o",
      object,
    ]);
    await compileC({ cPath: program, outPath: executable, linkInputs: [object], sanitize: true });
    const result = await exec(executable, [], { timeout: 60000 });
    expect(result.stdout).toBe("codec identity, tags, ownership and exceptions preserved\n");
    expect(result.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
