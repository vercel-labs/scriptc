// Generic function declarations stored in an object literal by name
// (`{ object: objectOf }`, `{ pick }`) hold their erased instance, like
// generic methods and arrow properties: the table compiles, its members
// read and call, and a round trip through `any` runs the erased instance.
export {};

type Schema<T> = { readonly decode: (input: unknown) => T };
type Infer<S> = S extends Schema<infer T> ? T : never;

function stringSchema(): Schema<string> {
  return { decode: (input) => String(input) };
}
function numberSchema(): Schema<number> {
  return { decode: (input) => Number(input) };
}
function objectOf<T extends Record<string, Schema<unknown>>>(
  shape: T,
): Schema<{ [K in keyof T]: Infer<T[K]> }> {
  return {
    decode: (input) => {
      const src = input as Record<string, unknown>;
      const fields = shape as Record<string, Schema<unknown>>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(fields)) out[key] = fields[key]!.decode(src[key]);
      return out as { [K in keyof T]: Infer<T[K]> };
    },
  };
}
function listOf<T>(inner: Schema<T>): Schema<T[]> {
  return { decode: (input) => (input as unknown[]).map((item) => inner.decode(item)) };
}

// A Zod-style builder table: never-called members still compile.
export const s = { string: stringSchema, number: numberSchema, object: objectOf, list: listOf };
console.log(Object.keys(s).join(","));

const person = s.object({ name: s.string(), age: s.number() });
const decoded = person.decode({ name: "Ada", age: "36" });
console.log(decoded.name.toUpperCase(), decoded.age + 1);
console.log(s.list(s.number()).decode(["1", "2", "3"]).join("+"));

// The shorthand form, `as const`, and a plain generic.
type Box<T> = { value: T };
function box<T>(value: T): Box<T> {
  return { value };
}
function pick<T extends object, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}
const kit = { box, pick } as const;
console.log(kit.box(1).value + 1, kit.box("a").value.length);
console.log(pick({ x: 1, y: "two" }, "y"));
console.log(typeof kit.box, typeof kit.pick);

// Through `any`, the stored member is the erased instance.
const loose: any = kit;
console.log(JSON.stringify(loose.box([1, 2])));
console.log(loose.pick({ a: true }, "a"));
