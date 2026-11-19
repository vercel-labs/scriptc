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

console.log(
  typeof __scrTypedVar,
  typeof __scrTypedFn,
  typeof __scrTypedClass,
  typeof __scrTypedNs,
  typeof __scrTypedEnum,
);
console.log(typeof __scrLocalClass, typeof __scrLocalEnum, typeof __scrLocalNs);
if (typeof __scrTypedNs === "undefined") console.log("namespace absent");
const absent = typeof __scrTypedClass !== "undefined";
console.log(absent, typeof __scrTypedClass === "function");
