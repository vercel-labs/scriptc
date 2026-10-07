import { F64, type IrModule } from "../../packages/compiler/src/ir/ir.js";
import { numLit } from "../../packages/compiler/src/ir/build.js";
import type { LlvmTargetOptions } from "../../packages/compiler/src/backend/llvm/emitter.js";
import { emitterInputCases } from "./self-hosting-emitter-inputs.js";

export interface LlvmEmitterRequest {
  targetTriple?: string;
  debug: boolean;
  sources: { file: string; text: string }[];
  pointerBits: 32 | 64;
  wasi: boolean;
  emitLibraryIdentity: boolean;
  runtimeAbiMarker: boolean;
}

export function llvmEmitterRequest(options: Partial<LlvmEmitterRequest> = {}): LlvmEmitterRequest {
  return {
    debug: false,
    sources: [],
    pointerBits: 64,
    wasi: false,
    emitLibraryIdentity: true,
    runtimeAbiMarker: false,
    ...options,
  };
}

export function llvmEmitterOptions(request: LlvmEmitterRequest): LlvmTargetOptions {
  return {
    ...(request.targetTriple === undefined ? {} : { targetTriple: request.targetTriple }),
    ...(request.debug
      ? { debugSources: new Map(request.sources.map((source) => [source.file, source.text])) }
      : {}),
    pointerBits: request.pointerBits,
    wasi: request.wasi,
    emitLibraryIdentity: request.emitLibraryIdentity,
    runtimeAbiMarker: request.runtimeAbiMarker,
  };
}

export interface LlvmEmitterCase {
  name: string;
  module: IrModule;
  request: LlvmEmitterRequest;
  contains: string[];
  excludes: string[];
}

export function llvmEmitterCases(): LlvmEmitterCase[] {
  // The LLVM emitter consumes complete IR, including library entry
  // points, recursive layouts, closure boxes and embedded package tables.
  const cases: LlvmEmitterCase[] = emitterInputCases().map((item) => ({
    name: item.name,
    module: item.module,
    request: llvmEmitterRequest({ debug: item.sources.length > 0, sources: item.sources }),
    contains: item.module.lib ? ["@native_init", "@native_collect"] : ["define i32 @main("],
    excludes: item.module.lib ? ["define i32 @main("] : [],
  }));
  const find = (name: string) => cases.find((item) => item.name === name)!;
  find("source locations with multibyte text").contains.push("!DILocation", "!DICompileUnit");
  find("global initialization and shutdown ownership").contains.push(
    "@scr_str_release",
    "@scr_arr_release",
  );
  find("recursive record trace and teardown").contains.push("@scr_cyc_alloc", "@scr_cyc_free");
  find("closure capture boxes").contains.push("@sc_retain_box", "@scr_closure_new");
  find("synchronous callback environment").contains.push(
    "alloca { %ScrClosure, [1 x ptr] }",
    "alloca %ScrBox",
    "@scr_str_release",
    "@sc_retain_box",
    "@scr_box_release",
  );
  find("synchronous callback environment").excludes.push("@scr_closure_new", "@scr_box_new");
  find("thread-local library globals").contains.push("thread_local");
  find("level-nine module and facade compression").contains.push("@scr_zlib_inflate_exact");
  for (const name of [
    "empty executable",
    "scalar, reference and tuple layouts",
    "class forest and virtual dispatch tables",
    "union scalar payloads and immortal units",
    "synchronous callback environment",
  ]) {
    const base = find(name);
    cases.push({
      ...base,
      name: `WASI 32-bit ${name}`,
      request: llvmEmitterRequest({ pointerBits: 32, wasi: true }),
      contains: [
        "%ScrStr = type { i32, i32, i32 }",
        ...(name === "synchronous callback environment"
          ? base.contains.filter((fragment) => !fragment.includes("@main("))
          : []),
      ],
      excludes: [
        "%ScrStr = type { i64, i64, i64 }",
        ...(name === "synchronous callback environment" ? base.excludes : []),
      ],
    });
  }
  const library = find("library entry points and identity constants");
  cases.push({
    ...library,
    name: "library with external identity getters",
    request: llvmEmitterRequest({ emitLibraryIdentity: false }),
    contains: ["@native_init"],
    excludes: ["define ptr @native_build_id", "define i32 @native_abi"],
  });
  const empty = find("empty executable");
  cases.push({
    ...empty,
    name: "runtime ABI marker reference",
    request: llvmEmitterRequest({ runtimeAbiMarker: true }),
    contains: ["call void @scr_runtime_abi_"],
    excludes: [],
  });
  const ffi = structuredClone(empty.module);
  const loc = ffi.functions[0]!.loc;
  ffi.ffiImports = [
    { name: "narrow", symbol: "native_narrow", params: ["i8", "u16", "f32"], returns: "i16" },
  ];
  ffi.functions[0]!.body = [
    {
      kind: "exprStmt",
      loc,
      expr: {
        kind: "ffiCall",
        import: "narrow",
        args: [-7, 65535, 0.5].map((value) => numLit(value, loc)),
        type: F64,
        loc,
      },
    },
  ];
  for (const [targetTriple, extend] of [
    ["arm64-apple-macos", true],
    ["x86_64-unknown-linux-gnu", true],
    ["aarch64-unknown-linux-gnu", false],
    ["x86_64-pc-windows-msvc", false],
    ["wasm32-unknown-wasi", true],
  ] as const) {
    const declaration = extend
      ? "declare signext i16 @native_narrow(i8 signext, i16 zeroext, float)"
      : "declare i16 @native_narrow(i8, i16, float)";
    cases.push({
      name: `narrow FFI ABI ${targetTriple}`,
      module: ffi,
      request: llvmEmitterRequest({
        targetTriple,
        pointerBits: targetTriple.startsWith("wasm32") ? 32 : 64,
      }),
      contains: [declaration, "fptrunc double"],
      excludes: [],
    });
  }
  return cases;
}
