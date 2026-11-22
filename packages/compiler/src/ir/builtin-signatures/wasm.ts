import { BOOL, DYN, F64 } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The wasm builtin call slots. */
export const wasmSignatures = defineLibFnSignatures({
  /** WebAssembly (scr_wasm.c): modules translated at build time
   * (wasm/translate.ts), found at run time by the SHA-256 of their bytes.
   * compile and instantiate over bytes settle on a later loop turn;
   * instantiate over a Module settles now, as in Node. `wasm.is` answers
   * instanceof for Module, Instance, Memory, Table and Global (kinds 0-4)
   * and CompileError, LinkError and RuntimeError (5-7); `wasm.errorNew`
   * constructs one of the error classes (kind 5-7, message, options). */
  "wasm.compile": { argTypes: [DYN], result: { kind: "promise", inner: DYN } },
  "wasm.validate": { argTypes: [DYN], result: BOOL },
  "wasm.instantiate": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "wasm.moduleNew": { argTypes: [DYN], result: DYN },
  "wasm.instanceNew": { argTypes: [DYN, DYN], result: DYN },
  "wasm.is": { argTypes: [DYN, F64], result: BOOL },
  "wasm.errorNew": { argTypes: [F64, DYN, DYN], result: DYN },
  /** new WebAssembly.Memory(descriptor), Table(descriptor, value) and
   * Global(descriptor, value) (an undefined value is the type's default);
   * `wasm.withoutNew` throws the TypeError for Module, Instance, Memory,
   * Table or Global (kinds 0-4) called without new, after its arguments
   * evaluate. */
  "wasm.memoryNew": { argTypes: [DYN], result: DYN },
  "wasm.tableNew": { argTypes: [DYN, DYN], result: DYN },
  "wasm.globalNew": { argTypes: [DYN, DYN], result: DYN },
  "wasm.withoutNew": { argTypes: [F64, DYN, DYN], result: DYN },
  /** WebAssembly.Module.imports(module), exports(module) and
   * customSections(module, name): checked-dynamic arrays of descriptor
   * objects and ArrayBuffers. */
  "wasm.moduleImports": { argTypes: [DYN], result: DYN },
  "wasm.moduleExports": { argTypes: [DYN], result: DYN },
  "wasm.moduleCustomSections": { argTypes: [DYN, DYN], result: DYN },
  /** `v.valueOf()` on a WebAssembly-typed receiver: a Global's value,
   * dyn.valueOf's answer for anything else. */
  "wasm.valueOf": { argTypes: [DYN], result: DYN },
  /** WebAssembly.compile (0), instantiate (1) and validate (2) as function
   * values, and the namespace object holding them. */
  "wasm.function": { argTypes: [F64], result: DYN },
  "wasm.namespace": { argTypes: [], result: DYN },
  /** The global object viewed through a cast to a type with a WebAssembly
   * member: an object holding the namespace. */
  "wasm.globalView": { argTypes: [], result: DYN },
});
