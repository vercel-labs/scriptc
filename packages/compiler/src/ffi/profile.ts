/* Outbound native-FFI manifest. The manifest is configuration, never code:
 * it binds signature-only TypeScript declarations to C ABI symbols and
 * names the link inputs an executable build adds after its generated
 * translation unit.
 *
 * Format 1:
 * {
 *   "ffi_format": 1,
 *   "functions": [
 *     { "name": "nativeScale", "symbol": "native_scale",
 *       "params": ["f64"], "returns": "f64" }
 *   ],
 *   "libraries": ["native/libnative.a"],
 *   "system_libraries": ["m"]
 * }
 *
 * string and bytes parameters expand to the length-delimited C pair
 * `(const uint8_t *, size_t)`. Their storage is borrowed for the duration
 * of the call only. Return values deliberately stay scalar in format 1:
 * pointer ownership needs an allocator/free contract, not a guess.
 *
 * Format 2 preserves those value classes and adds exact-position callback
 * ABI entries. A callback and its optional opaque context carry the same
 * manifest-local id; context entries appear independently in BOTH the
 * native function's params and the callback's params, so their C positions
 * are described rather than guessed:
 *
 *   "params": [
 *     { "callback": { "id": "visit", "params": ["f64", { "context": "visit" }],
 *                     "returns": "f64", "lifetime": "call" } },
 *     { "context": "visit" }
 *   ]
 *
 * Context entries are compiler-supplied and consume no TypeScript
 * parameter. `lifetime: "call"` lets native code invoke the callback only
 * during the outer call. Format 4 adds `lifetime: "retained"` plus release
 * descriptors that reuse a registration's callback ABI and trampoline.
 *
 * Format 3 preserves format 2 and adds copy-in callback parameters:
 * `cstring` is one NUL-terminated pointer, while `string` and `bytes` are
 * pointer+length spans. The copies have ordinary scriptc ownership and no
 * lifetime relationship to the native storage.
 *
 * Format 4 preserves format 3 and adds retained callback registration:
 *
 *   { "callback": { "id": "tick", "params": [{ "context": "tick" }],
 *                   "returns": "void", "lifetime": "retained" } }
 *
 * A paired release parameter names that descriptor. Its resolved profile
 * node carries the inherited ABI, but those fields are never accepted from
 * JSON:
 *
 *   { "callback": { "release": "timerAdd:tick" } }
 *   { "context": "timerAdd:tick" } */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ffiProfileDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";

export const FFI_PARAM_CLASSES = [
  "f64",
  "bool",
  "u8",
  "u32",
  "i32",
  "string",
  "bytes",
] as const;

export const FFI_RETURN_CLASSES = ["f64", "bool", "u8", "u32", "i32", "void"] as const;
export const FFI_CALLBACK_PARAM_CLASSES = [
  "f64",
  "bool",
  "u8",
  "u32",
  "i32",
  "cstring",
  "string",
  "bytes",
] as const;
const FFI_FORMAT_2_CALLBACK_PARAM_CLASSES = ["f64", "bool", "u8", "u32", "i32"] as const;

export type FfiValueParamClass = (typeof FFI_PARAM_CLASSES)[number];
export type FfiReturnClass = (typeof FFI_RETURN_CLASSES)[number];
export type FfiCallbackParamClass = (typeof FFI_CALLBACK_PARAM_CLASSES)[number];

export interface FfiContextParam {
  /** Manifest-local callback id whose closure pointer occupies this slot. */
  context: string;
}

export interface FfiCallbackParam {
  callback: {
    /** Unique within the containing native function. */
    id: string;
    /** Exact native callback ABI; a context entry consumes no TS argument. */
    params: (FfiCallbackParamClass | FfiContextParam)[];
    returns: FfiReturnClass;
    /** Dynamic-extent borrow, or explicitly paired retained registration. */
    lifetime: "call" | "retained";
  };
}

export interface FfiReleaseParam {
  callback: {
    /** `<binding>:<callback-id>` of the retained descriptor being released. */
    release: string;
    /** Inherited from the target after whole-manifest cross-checking. */
    params: (FfiCallbackParamClass | FfiContextParam)[];
    /** Inherited from the target after whole-manifest cross-checking. */
    returns: FfiReturnClass;
  };
}

export type FfiParamClass =
  | FfiValueParamClass
  | FfiCallbackParam
  | FfiReleaseParam
  | FfiContextParam;

export interface FfiFunction {
  /** The signature-only TypeScript function declaration's binding name. */
  name: string;
  /** The external C symbol linked into the executable. */
  symbol: string;
  params: FfiParamClass[];
  returns: FfiReturnClass;
}

export interface FfiProfile {
  ffiFormat: 1 | 2 | 3 | 4;
  functions: FfiFunction[];
  /** Absolute paths, resolved relative to the manifest. */
  libraries: string[];
  /** Driver-neutral names; the linker receives each as `-l<name>`. */
  systemLibraries: string[];
}

class FfiProfileError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

const C_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SYSTEM_LIBRARY = /^[A-Za-z0-9_+.-]+$/;

function rejectUnknownKeys(obj: object, path: string, known: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      const field = path === "" ? key : `${path}.${key}`;
      throw new FfiProfileError(
        `unknown field '${field}' ` +
          "(root and function keys are strict so an ABI typo cannot be ignored)",
      );
    }
  }
}

function stringField(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new FfiProfileError(`'${path}' must be a string`);
  }
  if (value === "") throw new FfiProfileError(`'${path}' must be non-empty`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new FfiProfileError(`'${path}' must be an array`);
  return value.map((entry, i) => stringField(entry, `${path}[${i}]`));
}

function contextParam(value: unknown, path: string): FfiContextParam | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!("context" in rec)) return null;
  rejectUnknownKeys(rec, path, ["context"]);
  return { context: stringField(rec["context"], `${path}.context`) };
}

interface UnresolvedFfiReleaseParam {
  callback: { release: string };
}

type UnresolvedFfiParamClass = FfiParamClass | UnresolvedFfiReleaseParam;

function callbackParam(
  value: unknown,
  path: string,
  format: 2 | 3 | 4,
): FfiCallbackParam | UnresolvedFfiReleaseParam | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (!("callback" in rec)) return null;
  rejectUnknownKeys(rec, path, ["callback"]);
  const raw = rec["callback"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FfiProfileError(`'${path}.callback' must be an object`);
  }
  const callback = raw as Record<string, unknown>;
  if ("release" in callback) {
    if (format < 4) {
      throw new FfiProfileError(`'${path}.callback.release' requires ffi_format 4`);
    }
    rejectUnknownKeys(callback, `${path}.callback`, ["release"]);
    return {
      callback: { release: stringField(callback["release"], `${path}.callback.release`) },
    };
  }
  rejectUnknownKeys(callback, `${path}.callback`, ["id", "params", "returns", "lifetime"]);
  const id = stringField(callback["id"], `${path}.callback.id`);
  if (!TS_IDENT.test(id)) {
    throw new FfiProfileError(`'${path}.callback.id' is not a plain identifier: '${id}'`);
  }
  if (!Array.isArray(callback["params"])) {
    throw new FfiProfileError(`'${path}.callback.params' must be an array`);
  }
  const params = callback["params"].map((entry, i): FfiCallbackParamClass | FfiContextParam => {
    const entryPath = `${path}.callback.params[${i}]`;
    const allowed = format >= 3
      ? FFI_CALLBACK_PARAM_CLASSES
      : FFI_FORMAT_2_CALLBACK_PARAM_CLASSES;
    if (
      typeof entry === "string" &&
      (allowed as readonly string[]).includes(entry)
    ) {
      return entry as FfiCallbackParamClass;
    }
    if (
      typeof entry === "string" &&
      (FFI_CALLBACK_PARAM_CLASSES as readonly string[]).includes(entry)
    ) {
      throw new FfiProfileError(`'${entryPath}' class '${entry}' requires ffi_format 3`);
    }
    const context = contextParam(entry, entryPath);
    if (context !== null) return context;
    throw new FfiProfileError(
      `'${entryPath}' must be one of ${allowed.join("/")} or a context entry`,
    );
  });
  const returns = stringField(callback["returns"], `${path}.callback.returns`);
  if (!(FFI_RETURN_CLASSES as readonly string[]).includes(returns)) {
    throw new FfiProfileError(
      `'${path}.callback.returns' must be one of ${FFI_RETURN_CLASSES.join("/")}, got '${returns}'`,
    );
  }
  const lifetime = callback["lifetime"];
  if (lifetime !== "call" && lifetime !== "retained") {
    throw new FfiProfileError(`'${path}.callback.lifetime' must be 'call' or 'retained'`);
  }
  if (lifetime === "retained" && format < 4) {
    throw new FfiProfileError(`'${path}.callback.lifetime' value 'retained' requires ffi_format 4`);
  }
  return {
    callback: {
      id,
      params,
      returns: returns as FfiReturnClass,
      lifetime,
    },
  };
}

/** Parse and strictly validate one outbound native-FFI manifest. */
export function loadFfiProfile(
  profilePath: string,
): { ok: true; profile: FfiProfile } | { ok: false; diagnostics: ScrDiagnostic[] } {
  const fail = (detail: string): { ok: false; diagnostics: ScrDiagnostic[] } => ({
    ok: false,
    diagnostics: [ffiProfileDiag(detail, profilePath)],
  });
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(profilePath);
  } catch (err) {
    return fail(`cannot read manifest: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return fail(`manifest is not valid JSON (${(err as Error).message})`);
  }
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new FfiProfileError("manifest must be a JSON object");
    }
    const root = raw as Record<string, unknown>;
    const format = root["ffi_format"];
    if (format !== 1 && format !== 2 && format !== 3 && format !== 4) {
      throw new FfiProfileError(
        typeof format === "number"
          ? `unsupported ffi_format ${format} (this scriptc reads formats 1, 2, 3, and 4)`
          : "'ffi_format' must be the number 1, 2, 3, or 4",
      );
    }
    rejectUnknownKeys(root, "", [
      "ffi_format",
      "functions",
      "libraries",
      "system_libraries",
    ]);

    const functionsRaw = root["functions"];
    if (!Array.isArray(functionsRaw)) {
      throw new FfiProfileError("'functions' must be an array");
    }
    const names = new Set<string>();
    const symbols = new Set<string>();
    const functions = functionsRaw.map((entry, i): Omit<FfiFunction, "params"> & { params: UnresolvedFfiParamClass[] } => {
      const path = `functions[${i}]`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new FfiProfileError(`'${path}' must be an object`);
      }
      rejectUnknownKeys(entry, path, ["name", "symbol", "params", "returns"]);
      const row = entry as Record<string, unknown>;
      const name = stringField(row["name"], `${path}.name`);
      if (!TS_IDENT.test(name)) {
        throw new FfiProfileError(`'${path}.name' is not a plain TypeScript identifier: '${name}'`);
      }
      if (names.has(name)) {
        throw new FfiProfileError(`function binding '${name}' is declared twice`);
      }
      names.add(name);

      const symbol = stringField(row["symbol"], `${path}.symbol`);
      if (!C_IDENT.test(symbol)) {
        throw new FfiProfileError(`'${path}.symbol' is not a C identifier: '${symbol}'`);
      }
      if (symbols.has(symbol)) {
        throw new FfiProfileError(`native symbol '${symbol}' is declared twice`);
      }
      symbols.add(symbol);

      if (!Array.isArray(row["params"])) {
        throw new FfiProfileError(`'${path}.params' must be an array`);
      }
      const params = row["params"].map((value, j): UnresolvedFfiParamClass => {
        const paramPath = `${path}.params[${j}]`;
        if (
          typeof value !== "string" ||
          !(FFI_PARAM_CLASSES as readonly string[]).includes(value)
        ) {
          if (format >= 2) {
            const callback = callbackParam(value, paramPath, format as 2 | 3 | 4);
            if (callback !== null) return callback;
            const context = contextParam(value, paramPath);
            if (context !== null) return context;
          }
          throw new FfiProfileError(
            format === 1
              ? `'${paramPath}' must be one of ${FFI_PARAM_CLASSES.join("/")}, got ${JSON.stringify(value)}`
              : `'${paramPath}' must be one of ${FFI_PARAM_CLASSES.join("/")}, a callback, or a context entry`,
          );
        }
        return value as FfiValueParamClass;
      });
      if (format >= 2) {
        const callbacks = new Map<string, FfiCallbackParam["callback"]>();
        const releases = new Set<string>();
        const outerContexts = new Map<string, number>();
        for (const param of params) {
          if (typeof param === "object" && "callback" in param) {
            const cb = param.callback;
            if ("release" in cb) {
              if (releases.has(cb.release)) {
                throw new FfiProfileError(
                  `callback release '${cb.release}' is declared twice in '${path}.params'`,
                );
              }
              releases.add(cb.release);
            } else {
              if (callbacks.has(cb.id)) {
                throw new FfiProfileError(`callback id '${cb.id}' is declared twice in '${path}.params'`);
              }
              callbacks.set(cb.id, cb);
            }
          } else if (typeof param === "object") {
            outerContexts.set(param.context, (outerContexts.get(param.context) ?? 0) + 1);
          }
        }
        for (const [id, count] of outerContexts) {
          if (!callbacks.has(id) && !releases.has(id)) {
            throw new FfiProfileError(`context '${id}' in '${path}.params' has no matching callback`);
          }
          if (count !== 1) {
            throw new FfiProfileError(`context '${id}' appears ${count} times in '${path}.params'; exactly one is required`);
          }
        }
        for (const [id, cb] of callbacks) {
          const callbackContexts = cb.params.filter(
            (param): param is FfiContextParam => typeof param === "object",
          );
          for (const context of callbackContexts) {
            if (context.context !== id) {
              throw new FfiProfileError(
                `callback '${id}' contains context '${context.context}'; callback contexts must reference their own id`,
              );
            }
          }
          if (callbackContexts.length > 1) {
            throw new FfiProfileError(
              `callback '${id}' contains ${callbackContexts.length} context parameters; at most one is supported`,
            );
          }
          const outerCount = outerContexts.get(id) ?? 0;
          if ((callbackContexts.length === 1) !== (outerCount === 1)) {
            throw new FfiProfileError(
              `callback '${id}' must declare its context exactly once in both the native function and callback parameter lists, or in neither`,
            );
          }
        }
      }
      const returns = stringField(row["returns"], `${path}.returns`);
      if (!(FFI_RETURN_CLASSES as readonly string[]).includes(returns)) {
        throw new FfiProfileError(
          `'${path}.returns' must be one of ${FFI_RETURN_CLASSES.join("/")}, got '${returns}'`,
        );
      }
      return { name, symbol, params, returns: returns as FfiReturnClass };
    });

    if (format >= 4) {
      const retained = new Map<string, FfiCallbackParam["callback"]>();
      for (const fn of functions) {
        for (const param of fn.params) {
          if (
            typeof param === "object" &&
            "callback" in param &&
            !("release" in param.callback) &&
            param.callback.lifetime === "retained"
          ) {
            retained.set(`${fn.name}:${param.callback.id}`, param.callback);
          }
        }
      }
      for (const [i, fn] of functions.entries()) {
        for (const [j, param] of fn.params.entries()) {
          if (
            typeof param !== "object" ||
            !("callback" in param) ||
            !("release" in param.callback)
          ) continue;
          const target = param.callback.release;
          const descriptor = retained.get(target);
          if (descriptor === undefined) {
            const [binding, id, ...extra] = target.split(":");
            const candidate = extra.length === 0 && binding !== undefined && id !== undefined
              ? functions.find((entry) => entry.name === binding)?.params.find(
                (entry) =>
                  typeof entry === "object" &&
                  "callback" in entry &&
                  !("release" in entry.callback) &&
                  entry.callback.id === id,
              )
              : undefined;
            if (
              candidate !== undefined &&
              typeof candidate === "object" &&
              "callback" in candidate &&
              !("release" in candidate.callback)
            ) {
              throw new FfiProfileError(
                `release '${target}' in 'functions[${i}].params[${j}]' targets a non-retained callback`,
              );
            }
            throw new FfiProfileError(
              `release '${target}' in 'functions[${i}].params[${j}]' has no matching retained callback`,
            );
          }
          /* The emitted lifecycle is pin -> require -> native call -> commit ->
           * release. A call that registers its own release target either
           * retires the released pin during the commit sweep or satisfies the
           * pre-call require with the pin it just created, so the
           * release-validation trap cannot hold. */
          const registeredBySameCall = fn.params.some(
            (entry) =>
              typeof entry === "object" &&
              "callback" in entry &&
              !("release" in entry.callback) &&
              `${fn.name}:${entry.callback.id}` === target,
          );
          if (registeredBySameCall) {
            throw new FfiProfileError(
              `release '${target}' in 'functions[${i}].params[${j}]' targets a retained callback registered by the same call; registration and release must be separate bindings`,
            );
          }
          const inheritedContext = descriptor.params.some(
            (entry) => typeof entry === "object",
          );
          const contextCount = fn.params.filter(
            (entry) => typeof entry === "object" && "context" in entry && entry.context === target,
          ).length;
          if (inheritedContext !== (contextCount === 1)) {
            throw new FfiProfileError(
              inheritedContext
                ? `release '${target}' must declare its context exactly once in the native function parameter list because the retained callback has a context`
                : `release '${target}' must not declare a context in the native function parameter list because the retained callback has none`,
            );
          }
          fn.params[j] = {
            callback: {
              release: target,
              params: descriptor.params,
              returns: descriptor.returns,
            },
          };
        }
      }
    }

    const resolvedFunctions = functions as FfiFunction[];

    const libraries = stringArray(root["libraries"], "libraries").map((path) =>
      resolve(dirname(profilePath), path)
    );
    const systemLibraries = stringArray(
      root["system_libraries"],
      "system_libraries",
    );
    for (const [i, name] of systemLibraries.entries()) {
      if (!SYSTEM_LIBRARY.test(name) || name.startsWith("-")) {
        throw new FfiProfileError(
          `'system_libraries[${i}]' is not a library name: '${name}'`,
        );
      }
    }
    if (new Set(libraries).size !== libraries.length) {
      throw new FfiProfileError("'libraries' contains a duplicate path");
    }
    for (const [i, path] of libraries.entries()) {
      try {
        if (!statSync(path).isFile()) {
          throw new FfiProfileError(
            `'libraries[${i}]' does not name a file: '${path}'`,
          );
        }
      } catch (err) {
        if (err instanceof FfiProfileError) throw err;
        throw new FfiProfileError(
          `'libraries[${i}]' cannot be read at '${path}': ${(err as Error).message}`,
        );
      }
    }
    if (new Set(systemLibraries).size !== systemLibraries.length) {
      throw new FfiProfileError("'system_libraries' contains a duplicate name");
    }
    return {
      ok: true,
      profile: {
        ffiFormat: format,
        functions: resolvedFunctions,
        libraries,
        systemLibraries,
      },
    };
  } catch (err) {
    if (err instanceof FfiProfileError) return fail(err.detail);
    throw err;
  }
}
