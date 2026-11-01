// Reassigning an annotated let that kept its initializer's layout: the kept
// `{ n: any; k: number }` layout rebuilds the assigned value, so the write
// through the assigned name would reach only the copy.
type Item = { n: number; k: number };

function f(anyValue: any): void {
  const value = { n: anyValue, k: 1 };
  let alias: Item = value;
  const replacement: Item = { n: 2, k: 3 };
  alias = replacement;
  replacement.n = 9;
  console.log(alias.n);
}

f(1);
