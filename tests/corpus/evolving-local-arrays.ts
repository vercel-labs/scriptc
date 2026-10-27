// An unannotated `const xs = []` inside a function takes the element type
// its later reads have, as TypeScript evolves it from the writes: records
// pushed in a loop, numbers, strings, and pushes from a closure. Reads that
// disagree, or a reassigned binding, keep a dynamic array, as at module
// scope.
function build(raw: number[]): { id: number; name: string }[] {
  const nodes = [];
  for (let i = 0; i < raw.length; i++) nodes.push({ id: raw[i]!, name: "n" + i });
  return nodes;
}
console.log(build([4, 5]).map((n) => n.name).join(","));

function numbers(): string {
  const xs = [];
  xs.push(1);
  xs.push(2);
  return xs.join(",");
}
function strings(): string {
  const ys = [];
  ys.push("a");
  ys.unshift("z");
  return ys.join("-");
}
console.log(numbers(), strings());

function mixed(): string {
  const xs = [];
  xs.push(1);
  const first = xs.length;
  xs.push("two");
  return `${first} ${xs.join("|")}`;
}
function captured(): number {
  const ys = [];
  const add = (v: number): void => {
    ys.push(v);
  };
  add(3);
  add(4);
  return ys.length;
}
function reassigned(): string {
  let zs = [];
  zs.push(true);
  zs = [false, true];
  return zs.join(",");
}
console.log(mixed(), captured(), reassigned());
