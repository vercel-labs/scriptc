/* The string-keyed properties Node 24 exposes on its builtin constructor
 * and namespace globals, own and inherited, so `"key" in Error` (a feature
 * probe such as `"captureStackTrace" in Error`) answers statically. The
 * global must be the unshadowed builtin; compiled programs cannot add
 * properties to these objects, so the answer is fixed. */

const FUNCTION_PROTOTYPE = [
  "length",
  "name",
  "arguments",
  "caller",
  "constructor",
  "apply",
  "bind",
  "call",
  "toString",
];
const OBJECT_PROTOTYPE = [
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "__proto__",
  "toLocaleString",
];
const CONSTRUCTOR_OWN = ["length", "name", "prototype"];
const ERROR_OWN = [
  ...CONSTRUCTOR_OWN,
  "captureStackTrace",
  "prepareStackTrace",
  "isError",
  "stackTraceLimit",
];

/** Own string keys per global, beyond what the prototype chain adds. */
const CONSTRUCTORS: Readonly<Record<string, readonly string[]>> = {
  Error: ERROR_OWN,
  // The native error constructors inherit from Error.
  TypeError: ERROR_OWN,
  RangeError: ERROR_OWN,
  SyntaxError: ERROR_OWN,
  ReferenceError: ERROR_OWN,
  EvalError: ERROR_OWN,
  URIError: ERROR_OWN,
  Object: [
    ...CONSTRUCTOR_OWN,
    "assign",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "hasOwn",
    "is",
    "preventExtensions",
    "seal",
    "create",
    "defineProperties",
    "defineProperty",
    "freeze",
    "getPrototypeOf",
    "setPrototypeOf",
    "isExtensible",
    "isFrozen",
    "isSealed",
    "keys",
    "entries",
    "fromEntries",
    "values",
    "groupBy",
  ],
  Array: [...CONSTRUCTOR_OWN, "isArray", "from", "fromAsync", "of"],
  Promise: [
    ...CONSTRUCTOR_OWN,
    "all",
    "allSettled",
    "any",
    "race",
    "resolve",
    "reject",
    "withResolvers",
    "try",
  ],
  Number: [
    ...CONSTRUCTOR_OWN,
    "isFinite",
    "isInteger",
    "isNaN",
    "isSafeInteger",
    "parseFloat",
    "parseInt",
    "MAX_VALUE",
    "MIN_VALUE",
    "NaN",
    "NEGATIVE_INFINITY",
    "POSITIVE_INFINITY",
    "MAX_SAFE_INTEGER",
    "MIN_SAFE_INTEGER",
    "EPSILON",
  ],
  String: [...CONSTRUCTOR_OWN, "fromCharCode", "fromCodePoint", "raw"],
  Map: [...CONSTRUCTOR_OWN, "groupBy"],
  Set: CONSTRUCTOR_OWN,
  WeakMap: CONSTRUCTOR_OWN,
  WeakSet: CONSTRUCTOR_OWN,
  Boolean: CONSTRUCTOR_OWN,
  Function: CONSTRUCTOR_OWN,
  Date: [...CONSTRUCTOR_OWN, "now", "parse", "UTC"],
  BigInt: [...CONSTRUCTOR_OWN, "asUintN", "asIntN"],
};

/** Whether Node answers `key in <name>` with true, or null when `name` is
 * not a tabled global. */
export function builtinGlobalHasKey(name: string, key: string): boolean | null {
  const own = CONSTRUCTORS[name];
  if (own === undefined) return null;
  return own.includes(key) || FUNCTION_PROTOTYPE.includes(key) || OBJECT_PROTOTYPE.includes(key);
}
