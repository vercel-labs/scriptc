// An unannotated `const xs = []` inside a function whose writes store values
// of more than one element type: an alias taken between the writes
// (`const alias = xs`) and an alias of that alias name the same array, so
// they see every later write, as in Node. A write of another element type
// after reads that agree on one type also keeps the array untyped.
function chain(): string {
  const xs = [];
  xs.push(1);
  const a = xs;
  const b = a;
  xs.push("two");
  b.push(3);
  return `${xs.join(",")} ${a.length} ${b.length} ${a === xs} ${b === xs}`;
}
function viaAlias(): string {
  const xs = [];
  xs.push("a");
  const alias = xs;
  alias.push("b");
  xs.push(2);
  return `${xs.join(",")} ${alias.join(",")}`;
}
function letAlias(): string {
  const xs = [];
  xs.push(true);
  let alias = xs;
  xs.push("t");
  const seen = alias.length;
  alias = [];
  return `${seen} ${alias.length} ${xs.length}`;
}
function nested(flag: boolean): string {
  const xs = [];
  xs.push(1);
  if (flag) {
    const inner = xs;
    xs.push("n");
    return `${inner.length} ${inner.join(":")}`;
  }
  return `${xs.length}`;
}
function elementWrite(): string {
  const xs = [];
  xs.push(1);
  const alias = xs;
  xs[1] = "one";
  return `${alias.length} ${alias.join("+")}`;
}
function agreeing(): string {
  const xs = [];
  xs.push(1);
  const alias = xs;
  xs.push(2);
  return `${alias.length} ${alias === xs} ${alias.reduce((sum, v) => sum + v, 0)}`;
}
function total(values: number[]): number {
  return values.length;
}
function passed(): string {
  const xs = [];
  xs.push(1);
  const alias = xs;
  const n = total(alias);
  xs.push("z");
  return `${n} ${alias.length}`;
}
console.log(chain());
console.log(viaAlias(), "|", letAlias());
console.log(nested(true), "|", nested(false), "|", elementWrite());
console.log(agreeing(), "|", passed());

function spreadSame(): number {
  const xs = [];
  xs.push(1);
  const more = [2, 3];
  xs.push(...more);
  return xs.reduce((sum, v) => sum + v, 0);
}
console.log(spreadSame());

// An object or array literal that holds the array between the writes
// (`{ items: xs }`, `[xs]`, a shorthand property, a nested literal), a
// binding of such a literal, and a name destructured from one hold the
// same array, so they see the later writes.
function objectHolder(): string {
  const xs = [];
  xs.push(1);
  const box = { items: xs, label: "box" };
  xs.push("two");
  box.items.push(3);
  return `${box.items.length} ${box.items === xs} ${box.items[1]} ${box.label} ${xs.join(",")}`;
}
function arrayHolder(): string {
  const xs = [];
  xs.push(1);
  const rows = [xs, [5]];
  xs.push("two");
  let total = 0;
  for (const row of rows) total += row.length;
  return `${rows[0].length} ${rows[0] === xs} ${rows[0][1]} ${total}`;
}
function shorthandHolder(): string {
  const xs = [];
  xs.push(1);
  const box = { xs, count: 3 };
  xs.push("two");
  return `${box.xs.length} ${box.xs === xs} ${box.count}`;
}
function nestedHolder(): string {
  const xs = [];
  xs.push(1);
  const box = { inner: [xs], pair: [{ items: xs }] };
  const outer = { box };
  xs.push("two");
  return `${box.inner[0].length} ${box.pair[0].items === xs} ${outer.box.inner[0][1]}`;
}
function holderAliases(): string {
  const xs = [];
  xs.push(1);
  const box = { items: xs };
  const other = box;
  const { items } = box;
  xs.push("two");
  return `${other.items.length} ${items.length} ${items === xs} ${JSON.stringify(other)}`;
}
console.log(objectHolder(), "|", arrayHolder(), "|", shorthandHolder());
console.log(nestedHolder(), "|", holderAliases());
