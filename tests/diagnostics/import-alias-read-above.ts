// A reference to an `import x = N.y` alias written above the alias. Node's
// transform binds only the references below the alias statement, so this
// one throws ReferenceError whenever its function runs, before the alias
// statement and after it. Reading the alias's storage would answer a
// value instead, so the reference is refused by name.
function tool(): string {
  return "t";
}
namespace tool {
  export function twice(n: number): number {
    return n * 2;
  }
}
namespace plain {
  export let unit = "m";
}
function early(): string {
  return unit;
}
const earlyCall = (): number => twice(2);
import unit = plain.unit;
import twice = tool.twice;
function late(): string {
  return unit + twice(3);
}
console.log(early(), earlyCall(), late());
