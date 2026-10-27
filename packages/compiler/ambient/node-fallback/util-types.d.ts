/* node:util/types — native runtime brands. Other forms retain their
 * per-member lowering boundaries. */
declare module "util/types" {
  export function isAnyArrayBuffer(value: unknown): boolean;
  export function isArrayBuffer(value: unknown): value is ArrayBuffer;
  export function isArrayBufferView(value: unknown): value is ArrayBufferView;
  export function isDataView(value: unknown): value is DataView;
  export function isTypedArray(value: unknown): boolean;
  export function isUint8Array(value: unknown): value is Uint8Array;
  export function isUint8ClampedArray(value: unknown): value is Uint8ClampedArray;
  export function isUint16Array(value: unknown): value is Uint16Array;
  export function isUint32Array(value: unknown): value is Uint32Array;
  export function isInt8Array(value: unknown): value is Int8Array;
  export function isInt16Array(value: unknown): value is Int16Array;
  export function isInt32Array(value: unknown): value is Int32Array;
  export function isFloat16Array(value: unknown): value is Float16Array;
  export function isFloat32Array(value: unknown): value is Float32Array;
  export function isFloat64Array(value: unknown): value is Float64Array;
  export function isMap(value: unknown): value is Map<unknown, unknown>;
  export function isSet(value: unknown): value is Set<unknown>;
  export function isWeakMap(value: unknown): value is WeakMap<object, unknown>;
  export function isWeakSet(value: unknown): value is WeakSet<object>;
  export function isRegExp(value: unknown): value is RegExp;
  export function isNativeError(value: unknown): value is Error;
  export function isPromise(value: unknown): value is Promise<unknown>;
  export function isProxy(value: unknown): boolean;
  export function isAsyncFunction(value: unknown): boolean;
  export function isGeneratorFunction(value: unknown): boolean;
  export function isGeneratorObject(value: unknown): boolean;
  export function isModuleNamespaceObject(value: unknown): boolean;
  export function isDate(value: unknown): value is Date;
  export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer;
  export function isMapIterator(value: unknown): boolean;
  export function isSetIterator(value: unknown): boolean;
  export function isKeyObject(value: unknown): boolean;
  export function isNumberObject(value: unknown): boolean;
  export function isStringObject(value: unknown): boolean;
  export function isBooleanObject(value: unknown): boolean;
  export function isBigIntObject(value: unknown): boolean;
  export function isSymbolObject(value: unknown): boolean;
  export function isBoxedPrimitive(value: unknown): boolean;
  export function isBigInt64Array(value: unknown): value is BigInt64Array;
  export function isBigUint64Array(value: unknown): value is BigUint64Array;
  export function isCryptoKey(value: unknown): boolean;
  export function isExternal(value: unknown): boolean;
}

declare module "node:util/types" {
  export * from "util/types";
}
