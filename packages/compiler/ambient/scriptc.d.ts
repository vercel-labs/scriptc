/* scriptc's shipped declarations — the ALWAYS-SHIPPED CORE. Programs
 * compile against the TypeScript ES standard library without lib.dom and
 * the project's @types/node when present: the checker sees the standard
 * surface, and the LOWERER is the scope fence — any reached use of it
 * without a lowering is a SC2020 diagnostic at its use site. This file
 * declares only what that ES-only library does not:
 *
 * 1. scriptc's own primitives (comptime).
 * 2. The RequestInfo type alias, supplied by the default DOM lib in ordinary
 *    TypeScript projects but absent from @types/node's globals.
 * 3. setTimeout/clearTimeout and the Timeout handle (Node/dyn territory the
 *    lib files don't cover; plain declarations, so with @types/node present
 *    they MERGE as overloads instead of colliding — the Timeout handle maps
 *    to the numeric timer id either way, and .unref()/.ref()/.hasRef() are
 *    loop-liveness bookkeeping).
 * 4. The WebAssembly namespace and BufferSource, which the DOM library
 *    supplies in ordinary TypeScript projects (types only; every reached
 *    use of the API is refused at its site).
 *
 * This file ships to EVERY program scriptc builds — the lowering program
 * and preflight's project-world second-chance program alike (a project
 * using comptime must typecheck in both). The divergence/precision
 * overrides (JSON.parse(): unknown, the Promise executor shape,
 * ...) live in scriptc-overrides.d.ts, which joins the LOWERING program only.
 *
 * console, process, and the "node:fs" module live in scriptc-node-fallback.d.ts,
 * shipped ONLY when the target project has no @types/node — with it, the
 * project's real Node types are the type surface and the fallback stands
 * down (its `declare const`/`declare module` forms would collide). The
 * lowering tables recognize the same members either way, by name +
 * provenance. */

/* The default TypeScript DOM lib supplies this name even for Node projects.
 * scriptc uses the ES lib and @types/node's fetch globals instead, while the
 * fallback fetch declarations use the same alias. It is only a type: runtime
 * fetch/Request support remains governed by the lowering fences. */
type RequestInfo = string | URL | Request;

/* Node exposes the codec constructors globally, but older @types/node
 * versions rely on lib.dom for their instance type names. Keep those types
 * available in the ES-only program as well as the fallback type world. */
interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}
interface TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(
    input?:
      | ArrayBuffer
      | DataView
      | Int8Array
      | Uint8Array
      | Uint8ClampedArray
      | Int16Array
      | Uint16Array
      | Int32Array
      | Uint32Array
      | Float32Array
      | Float64Array
      | BigInt64Array
      | BigUint64Array,
    options?: { stream?: boolean },
  ): string;
}

/* The timer handle — setTimeout's return, mapped to the numeric timer id.
 * unref() drops it from the event loop's keep-alive set (the process may
 * exit with the timer still armed — it never fires then, exactly Node);
 * ref() restores it; hasRef() reports the state. The methods return the
 * handle for chaining. Under @types/node this MERGES with NodeJS.Timeout
 * (both map to the same numeric handle). */
interface Timeout extends Disposable {
  ref(): Timeout;
  unref(): Timeout;
  hasRef(): boolean;
  /* Re-arms the timer to fire at now + the original delay (Node's
   * Timeout.refresh). Chaining like ref/unref. */
  refresh(): Timeout;
  [Symbol.dispose](): void;
}
/* The callback is invoked with NO arguments; the second overload admits a
 * callback declared with one parameter for the sleep idiom —
 * `setTimeout(resolve, ms)` with Promise<unknown>'s resolve — where the
 * zero-argument invocation delivers undefined (@types/node's generic
 * signature admits the same shape and MERGES with these). Promise<void>'s
 * resolve keeps matching the first overload (void params accept absence). */
declare function setTimeout(callback: () => void, ms?: number): Timeout;
declare function setTimeout(callback: (value?: unknown) => void, ms?: number): Timeout;
/* The trailing-argument form: Node passes the extras to the callback
 * (`setTimeout(cb, 0, 'foo')` fires cb('foo')). The callback slot accepts
 * any function shape (never[] rest — parameter-contravariance's bottom);
 * the delivered call rides the checked-dynamic boundary, so each argument
 * is validated against the callback's real signature at fire time. */
declare function setTimeout(
  callback: (...args: never[]) => void,
  ms?: number,
  ...args: unknown[]
): Timeout;
declare function clearTimeout(handle?: Timeout | number | null | undefined): void;

/* Compile-time evaluation. The callback must be an inline arrow/function
 * expression with NO references to outer bindings (it is extracted
 * source-textually and executed in an isolated node:vm context inside the
 * COMPILER's Node process); the returned value is baked into the binary as a
 * literal — numbers (finite), strings, booleans, arrays, and records,
 * nested. What type-checks runs with real JavaScript semantics, so the
 * baked result is exactly what Node would compute at runtime (the
 * differential harness verifies this with a `comptime = (f) => f()` shim). */
declare function comptime<T>(compute: () => T): T;

/* The JavaScript WebAssembly API, as the DOM library declares it (scriptc's
 * ES-only type world never loads lib.dom, and @types/node leaves it to
 * lib.dom). Packages whose declarations name these types (quickjs-wasi,
 * photon-node, ...) typecheck against them. These are types only: the
 * type mapper gives every type declared here the checked-dynamic
 * representation, and the lowerer refuses each reached use of the API with
 * a located diagnostic (frontend/lowering/builtins/webassembly.ts).
 * BufferSource admits every ArrayBufferView, as lib.dom did before
 * TypeScript 5.7: Node's Buffer types are views over ArrayBufferLike. */
type BufferSource = ArrayBufferView | ArrayBuffer;
declare namespace WebAssembly {
  interface CompileError extends Error {}
  var CompileError: {
    prototype: CompileError;
    new (message?: string): CompileError;
    (message?: string): CompileError;
  };
  interface Global<T extends ValueType = ValueType> {
    value: ValueTypeMap[T];
    valueOf(): ValueTypeMap[T];
  }
  var Global: {
    prototype: Global;
    new <T extends ValueType = ValueType>(
      descriptor: GlobalDescriptor<T>,
      v?: ValueTypeMap[T],
    ): Global<T>;
  };
  interface Instance {
    readonly exports: Exports;
  }
  var Instance: {
    prototype: Instance;
    new (module: Module, importObject?: Imports): Instance;
  };
  interface LinkError extends Error {}
  var LinkError: {
    prototype: LinkError;
    new (message?: string): LinkError;
    (message?: string): LinkError;
  };
  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  var Memory: {
    prototype: Memory;
    new (descriptor: MemoryDescriptor): Memory;
  };
  interface Module {}
  var Module: {
    prototype: Module;
    new (bytes: BufferSource): Module;
    customSections(moduleObject: Module, sectionName: string): ArrayBuffer[];
    exports(moduleObject: Module): ModuleExportDescriptor[];
    imports(moduleObject: Module): ModuleImportDescriptor[];
  };
  interface RuntimeError extends Error {}
  var RuntimeError: {
    prototype: RuntimeError;
    new (message?: string): RuntimeError;
    (message?: string): RuntimeError;
  };
  interface Table {
    readonly length: number;
    get(index: number): any;
    grow(delta: number, value?: any): number;
    set(index: number, value?: any): void;
  }
  var Table: {
    prototype: Table;
    new (descriptor: TableDescriptor, value?: any): Table;
  };
  interface GlobalDescriptor<T extends ValueType = ValueType> {
    mutable?: boolean;
    value: T;
  }
  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
    shared?: boolean;
  }
  interface ModuleExportDescriptor {
    kind: ImportExportKind;
    name: string;
  }
  interface ModuleImportDescriptor {
    kind: ImportExportKind;
    module: string;
    name: string;
  }
  interface TableDescriptor {
    element: TableKind;
    initial: number;
    maximum?: number;
  }
  interface ValueTypeMap {
    anyfunc: Function;
    externref: any;
    f32: number;
    f64: number;
    i32: number;
    i64: bigint;
    v128: never;
  }
  interface WebAssemblyInstantiatedSource {
    instance: Instance;
    module: Module;
  }
  type ImportExportKind = "function" | "global" | "memory" | "table";
  type TableKind = "anyfunc" | "externref";
  type ExportValue = Function | Global | Memory | Table;
  type Exports = Record<string, ExportValue>;
  type ImportValue = ExportValue | number;
  type Imports = Record<string, ModuleImports>;
  type ModuleImports = Record<string, ImportValue>;
  type ValueType = keyof ValueTypeMap;
  function compile(bytes: BufferSource): Promise<Module>;
  function compileStreaming(source: Response | PromiseLike<Response>): Promise<Module>;
  function instantiate(
    bytes: BufferSource,
    importObject?: Imports,
  ): Promise<WebAssemblyInstantiatedSource>;
  function instantiate(moduleObject: Module, importObject?: Imports): Promise<Instance>;
  function instantiateStreaming(
    source: Response | PromiseLike<Response>,
    importObject?: Imports,
  ): Promise<WebAssemblyInstantiatedSource>;
  function validate(bytes: BufferSource): boolean;
}
