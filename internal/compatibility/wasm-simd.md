# WebAssembly SIMD translation

The compiler translates the 236 standard SIMD128 instructions and the 20 relaxed SIMD instructions. `wasm-simd-opcodes.json` records the instruction inventory. Modules may use vector locals, globals, block signatures, direct calls, indirect calls and imports between translated Wasm instances. Other unsupported proposals retain their existing refusals.

## Native and JavaScript boundaries

Vectors use LLVM `<16 x i8>` values, with bitcasts for other lane shapes. Globals have two contiguous 64-bit words. Imported globals share the original cell, including mutable globals. Scalar thunk slots and scalar native signatures keep their representation. A vector import resolves the exporting function's original native code and instance, so chained imports and indirect calls preserve all 128 bits without passing through JavaScript.

The [WebAssembly JavaScript interface](https://webassembly.github.io/spec/js-api/#exported-function-call) cannot convert `v128` values. An exported vector function is a valid callable object and can be linked to another Wasm module, but calling it from JavaScript throws `TypeError` before argument coercion or execution. An ordinary JavaScript function may satisfy a vector import at instantiation; attempting that call throws before invoking the function. Vector globals may be exported and imported as opaque `WebAssembly.Global` objects. Their JavaScript getter, setter and `valueOf` throw; constructing one from JavaScript also throws. These are normative boundaries, not unsupported SIMD modules.

Vector globals and vector function signatures use descriptor ABI 3, which an older runtime refuses before allocating an instance. Modules with scalar globals and signatures retain descriptor ABI 2; the new runtime accepts both versions. This keeps scalar translation stable while requiring rebuilt runtime packs for vector boundaries.

The adversarial `webassembly-simd-abi` fixtures were recovered from fork checkpoint `5538607fbdad667f3577d9e0a49020e9c5f9d6d1` and revalidated against this implementation. They cover high global bits, two vector arguments/results interleaved with scalars, imported tables, re-export chains, wrong signatures and JavaScript call non-execution. The checkpoint's reported test outcomes are not used as validation here.

## Validation and lowering

The decoder checks operand and control-stack types for SIMD, including unreachable code, lanes, shuffle indices and memory alignment. Vector constants and immediates are also handled in global initialization, call-graph scans and dead-code scans. Separate function signature hashes distinguish scalar and vector signatures.

Memory operations use unsigned wasm32 addresses and offsets in 64-bit arithmetic. Lane, extending and splat accesses use their actual widths. Unaligned accesses use alignment 1. SIMD stores check their entire range before writing in both bounds modes, preventing partial stores when LLVM legalizes a vector operation. Volatile accesses preserve traps for unused loads. Existing guard-page and checked-memory policies apply.

Integer lowering preserves wrapping, saturation, narrowing signedness and modulo-width shifts. Floating-point lowering preserves signed zeros, quiet arithmetic NaNs and operand-selection bits. It uses no fast-math flags. Target code generation uses the existing LLVM target policy, with no host CPU detection or new ISA requirement.

## Relaxed SIMD projections

Relaxed SIMD permits a fixed implementation choice for several operations. This implementation chooses strict swizzle, saturating float-to-int conversion, bitwise lane selection, strict float min/max and saturating Q15 multiplication. Multiply-add and negative multiply-add use separate multiplication and addition with two roundings. Dot products sign-extend both byte inputs, wrap adjacent sums in i16, and sign-extend those pairs before the i32 add. These choices are portable legal projections of the [core numeric semantics](https://github.com/WebAssembly/spec/blob/main/document/core/exec/numerics.rst). Code must not depend on matching V8's hardware-specific relaxed projection outside deterministic input domains.

## Tests

`gen-simd-data.mjs` generates 750 standard instruction modules covering every standard opcode, boundary operands, signed zeros, NaNs, conversions, memory edges and trap preservation. `gen-simd-contract.mjs` adds globals, linking, chained imports, indirect calls, JavaScript restrictions and deterministic-domain cases for every relaxed opcode.

`gen-simd-spec.mjs` compiles the official standard and relaxed SIMD suites into scalar assertion wrappers, including permitted alternative results and NaN predicates. Assertions execute inside Wasm, so vector values do not cross the JavaScript boundary. The generated manifest pins the source commit and assembler version and records any omitted cases. Corpus chunks bound compiler memory use. Invalid binary modules are separately checked against V8 and the decoder.

The reduced bridge consumer remains a separate fixture. Its three byte-array callbacks and SHA-256 export do not establish compatibility with the full bridge JavaScript package, DOM types, minified JavaScript or Baileyrs.
