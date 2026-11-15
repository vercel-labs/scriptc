// Arrays that hold a present undefined and no hole, passed into generic
// code: an optional-element array, the groups of a regular expression
// match, the pieces of a split with a capturing group. A for-of loop in a
// generic function binds the undefined.
function each<T>(xs: readonly T[], show: (v: T) => string): string {
  const out: string[] = [];
  for (const x of xs) out.push(x === undefined ? "-" : show(x));
  return out.join(",");
}

function count<T>(xs: T[]): number {
  let present = 0;
  for (const x of xs) if (x !== undefined) present++;
  return present;
}

function joined<T>(first: readonly T[], second: readonly T[], show: (v: T) => string): string {
  const out: string[] = [];
  for (const x of [...first, ...second]) out.push(x === undefined ? "-" : show(x));
  return out.join(",");
}

class Holder<T> {
  items: T[];
  constructor(items: T[]) {
    this.items = items;
  }
  list(show: (v: T) => string): string {
    const out: string[] = [];
    for (const x of this.items) out.push(x === undefined ? "-" : show(x));
    return out.join(",");
  }
}

const upper = (s: string): string => s.toUpperCase();

const optional: (string | undefined)[] = ["a", undefined, "c"];
console.log(each(optional, (v) => (v === undefined ? "none" : v)));
console.log(count(optional));
console.log(joined(optional, ["d"], (v) => (v === undefined ? "none" : v)));
console.log(new Holder(optional).list((v) => (v === undefined ? "none" : v)));

const pieces = "ab".split(/(x)?b/);
console.log(pieces.length, each(pieces, upper), count(pieces));
console.log(new Holder(pieces).list(upper));

const groups = "a1".match(/(a)(z)?(1)/);
if (groups !== null) {
  console.log(groups.length, each(groups, upper), count(groups));
  console.log(joined(groups, pieces, upper));
}

// Arrays of the same element types with nothing missing read as before.
const plain: string[] = ["x", "y"];
console.log(each(plain, upper), count(plain), joined(plain, plain, upper));
const numbers: number[] = [1, 2, 3];
console.log(each(numbers, (n) => String(n + 1)), count(numbers));
