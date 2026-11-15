// @transform-types
// A function merged with a namespace is ONE value in Node: the transform
// assigns every exported member onto the existing function object, so
// Object.keys enumerates the members in source order, `in` answers true,
// typeof stays "function", and a bare read inside the block sees a write
// made through the function's name.
function fmt(n: number): string {
  return fmt.prefix + n.toFixed(fmt.digits);
}
namespace fmt {
  export let prefix = "#";
  export const digits = 2;
}
console.log(fmt(3.14159));
fmt.prefix = "$";
console.log(fmt(1), Object.keys(fmt));
console.log("digits" in fmt, "prefix" in fmt, typeof fmt, fmt.digits);

const alias = fmt;
console.log(alias(2), alias.prefix, Object.keys(alias).join(","));

function tool(): string {
  return "t";
}
namespace tool {
  export const version = 1;
  export function twice(n: number): number {
    return n * 2;
  }
}
console.log(tool(), Object.keys(tool), tool.twice(2), tool.version);
