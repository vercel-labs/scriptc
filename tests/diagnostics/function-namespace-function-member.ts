// An exported function of a function+namespace merge is an own property
// of the function object, which holds one function value. A generic
// function has no value until a call picks its type arguments, and an
// overloaded one has a signature per overload: both are refused by name
// rather than called directly while `Object.keys` answers without them.
function tool(): string {
  return "t";
}
namespace tool {
  export function same<T>(x: T): T {
    return x;
  }
}
function pick(): string {
  return "p";
}
namespace pick {
  export function one(a: number): number;
  export function one(a: string): string;
  export function one(a: number | string): number | string {
    return a;
  }
}
console.log(tool(), pick());
