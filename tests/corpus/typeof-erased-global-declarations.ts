// Names a program only DECLARES for their types — an ambient namespace, class,
// enum, function or variable, in a `declare global` augmentation or at the
// file's top level — have no runtime binding. `typeof` on an unresolvable
// reference answers "undefined" and never throws (ECMA-262), so the erased
// declaration must not lower to a value read that throws Node's ReferenceError.
export {};

declare global {
  var __scrTypedVar: string;
  function __scrTypedFn(): void;
  class __scrTypedClass {
    x: number;
  }
  namespace __scrTypedNs {
    const y: number;
  }
  enum __scrTypedEnum {
    A,
  }
}

declare class __scrLocalClass {
  x: number;
}
declare enum __scrLocalEnum {
  A,
}
declare namespace __scrLocalNs {
  const z: number;
}

// These erase too, but the names are Node's own globals: the identifier
// still resolves to the global object at run time, so typeof answers what
// Node has there (`declare class Buffer {}` names Node's Buffer).
declare class Buffer {}
declare function fetch(input: string): Promise<unknown>;
declare const process: { env: Record<string, string> };
declare const navigator: { userAgent: string };

console.log(
  typeof __scrTypedVar,
  typeof __scrTypedFn,
  typeof __scrTypedClass,
  typeof __scrTypedNs,
  typeof __scrTypedEnum,
);
console.log(typeof __scrLocalClass, typeof __scrLocalEnum, typeof __scrLocalNs);
console.log(typeof Buffer, typeof fetch, typeof process, typeof navigator);
if (typeof Buffer === "undefined") console.log("buffer absent");
else console.log("buffer present");
if (typeof __scrTypedNs === "undefined") console.log("namespace absent");
const absent = typeof __scrTypedClass !== "undefined";
console.log(absent, typeof __scrTypedClass === "function");

// A program that installs one of these names on the global object answers
// that property, because an unbound identifier read consults the global
// object.
(globalThis as Record<string, unknown>).__scrTypedClass = 7;
(globalThis as Record<string, unknown>).__scrTypedNs = "installed";
(globalThis as Record<string, unknown>).__scrLocalEnum = "local";
console.log(typeof __scrTypedClass, typeof __scrTypedNs, typeof __scrLocalEnum);
