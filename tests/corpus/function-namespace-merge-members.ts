// @transform-types
// The members of a function+namespace merge, as Node's transform leaves
// them. An exported function is the block's own hoisted binding AND a
// property of the function object: a bare reference is the declaration
// (before the property is stored, and after it is replaced), while the
// qualified spelling reads the property, so a replaced member is the one a
// qualified call runs. Exported types are no properties at all.
function fmt(n: number, options?: fmt.Options): string {
  return (options?.prefix ?? fmt.prefix) + n.toFixed(fmt.digits);
}
namespace fmt {
  export interface Options {
    prefix: string;
  }
  export type Digits = number;
  export namespace Shapes {
    export interface Pair {
      left: number;
      right: number;
    }
  }
  // A bare read of an exported function before its declaration: the
  // hoisted function, not the property the block has not stored yet.
  const early: (n: number) => number = helper;
  export const viaEarly = early(2);
  export const viaCall = helper(3);
  export const digits: Digits = 2;
  export let prefix = "#";
  export function helper(n: number): number {
    return n * 2;
  }
  export function viaBare(n: number): number {
    const held: (n: number) => number = helper;
    return held(n) + helper(n);
  }
  export function sum(pair: Shapes.Pair): number {
    return pair.left + pair.right;
  }
}
console.log(fmt(3.14159), fmt(1, { prefix: "$" }));
console.log(fmt.viaEarly, fmt.viaCall, Object.keys(fmt).join(","));
console.log(fmt.helper(1), fmt.viaBare(1), fmt.sum({ left: 1, right: 2 }));

// Replacing the property: the qualified call and the qualified read see the
// new function, the bare references inside the block keep the declaration.
const before = fmt.helper;
Object.assign(fmt, { helper: (n: number): number => n * 100 });
const after = fmt.helper;
console.log(fmt.helper(1), after(1), before(1), fmt.viaBare(1));
console.log(before === after, Object.keys(fmt).join(","));
