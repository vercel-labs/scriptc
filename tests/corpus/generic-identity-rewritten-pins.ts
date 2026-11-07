// A binding, field or parameter that starts as one pin of a generic
// declaration and is rewritten may hold another function at a comparison,
// and a parameter holds whatever the call passes: each compares by identity
// with a pin at another signature, as in JavaScript, instead of being
// refused as two pins of one declaration.
function ident<T>(x: T): T {
  return x;
}
const num: (x: number) => number = ident;
const anyPin: (x: any) => any = ident;
let held: (x: any) => any = anyPin;
held = (x: any) => x;
console.log("rewritten", num === held, held === anyPin, num !== held);
class Holder {
  current: (x: any) => any = anyPin;
}
const holder = new Holder();
holder.current = (x: any) => x;
console.log("rewritten-field", num === holder.current);
function withDefault(f: (x: any) => any = anyPin): boolean {
  f = (x: any) => x;
  return num === f;
}
console.log("rewritten-parameter", withDefault(), withDefault(num));
// A parameter whose default is a pin holds whatever the call passes.
function compare(f: (x: any) => any = anyPin): boolean {
  return num === f;
}
console.log("parameter-argument", compare((x: any) => x), compare(num));
// A readonly field its constructor assigns holds what the constructor stores.
class Assigned {
  readonly held: (x: any) => any = anyPin;
  constructor(f: (x: any) => any) {
    this.held = f;
  }
}
console.log(
  "readonly-constructor",
  num === new Assigned((x: any) => x).held,
  num === new Assigned(num).held,
);
