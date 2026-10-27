// Mapped types over a generic function's own type parameters lower in its
// monomorphized instances: homomorphic copies, modifiers, conditional
// templates with infer, and indexed templates, including over an
// index-signature constraint whose keys only the instance knows.
type Schema<T> = { parse(input: unknown): T };
type Infer<S> = S extends Schema<infer T> ? T : never;
interface Typed<Output> {
  readonly _output: Output;
}
type Output<T extends Typed<unknown>> = T["_output"];

const str: Schema<string> = { parse: (input) => String(input) };
const num: Schema<number> = { parse: (input) => Number(input) };

function same<S>(value: S): { [K in keyof S]: S[K] } {
  return value;
}
function frozen<S extends object>(value: S): { readonly [K in keyof S]: S[K] } {
  return { ...value };
}
function loose<S extends object>(value: S): { [K in keyof S]?: S[K] } {
  return value;
}
function pair<S extends { left: Schema<unknown>; right: Schema<unknown> }>(
  shape: S,
  input: { left: unknown; right: unknown },
): { [K in keyof S]: Infer<S[K]> } {
  return {
    left: shape.left.parse(input.left),
    right: shape.right.parse(input.right),
  } as { [K in keyof S]: Infer<S[K]> };
}
function objectWith<S extends Record<string, Schema<unknown>>>(
  shape: S,
  build: (shape: S) => { [K in keyof S]: Infer<S[K]> },
): { [K in keyof S]: Infer<S[K]> } {
  const parsed: { [K in keyof S]: Infer<S[K]> } = build(shape);
  return parsed;
}
function outputs<S extends Record<string, Typed<unknown>>>(
  values: S,
  read: (values: S) => { [K in keyof S]: Output<S[K]> },
): { [K in keyof S]: Output<S[K]> } {
  return read(values);
}

const s = same({ a: 1, b: "two" });
console.log(s.a + 1, s.b.length);
const f = frozen({ x: true, y: [1, 2] });
console.log(f.x, f.y.length);
const l = loose({ n: 3 });
console.log(l.n ?? 0);
const p = pair({ left: str, right: num }, { left: 12, right: "34" });
console.log(p.left.length, p.right + 1);
const person = objectWith({ name: str, age: num }, (shape) => ({
  name: shape.name.parse("Ada"),
  age: shape.age.parse("36"),
}));
console.log(person.name, person.age + 1);
const out = outputs({ id: { _output: 7 }, tag: { _output: "t" } }, (values) => ({
  id: values.id._output,
  tag: values.tag._output,
}));
console.log(out.id * 2, out.tag.toUpperCase());
