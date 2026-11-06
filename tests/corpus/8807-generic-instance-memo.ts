// One written type (`Box<T>`, its element and its fields) maps to a different
// IR type in every generic instance that mentions it. The type memo is scoped
// by the installed binding maps (TypeMapperCtx.typeMemoFor); a memo keyed by
// the checker type id alone would hand the first instance's answer to the
// others and corrupt their slots.
interface Box<T> {
  value: T;
  tag: string;
}

function wrap<T>(value: T): Box<T>[] {
  const out: Box<T>[] = [];
  for (let i = 0; i < 3; i++) out.push({ value, tag: `t${i}` });
  return out;
}

function total<T>(boxes: Box<T>[], f: (v: T) => number): number {
  let sum = 0;
  for (const b of boxes) sum += f(b.value) + b.tag.length;
  return sum;
}

const a = wrap(2);
const b = wrap("xy");
const c = wrap({ n: 5 });
console.log(total(a, (v) => v * 10));
console.log(total(b, (v) => v.length));
console.log(total(c, (v) => v.n));
console.log(JSON.stringify(a[0]), JSON.stringify(b[1]), JSON.stringify(c[2]));
