// A generic options bag read through its constraint at a call site whose
// literal omits the member: `??`, `===`, `!` and `typeof` read the
// property, which Node answers as undefined.
interface Options {
  key?: string;
  label?: string;
}
function describe<O extends Options>(options: O): string {
  const a = options.key ?? "fallback";
  const b = options.key === undefined;
  const c = !options.key;
  const d = typeof options.key;
  return `${a} ${b} ${c} ${d}`;
}
console.log(describe({ label: "x" }));
console.log(describe({ key: "k", label: "y" }));
