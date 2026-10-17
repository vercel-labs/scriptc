// Mapped and conditional types over a generic function's type parameters,
// inside the instantiated body: the schema-library pattern (an object()
// combinator inferring its record from per-field schemas). The checker keeps
// `{ [K in keyof S]: Infer<S[K]> }` symbolic in the body; each instance maps
// it through the call site's resolved signature. Covers the mapped type
// returned directly, in a record field, as a function member's return, and
// a plain homomorphic map; two instances of one generic with different
// shapes; nesting; and the failure path.
type Schema<T> = { parse: (input: unknown) => T };
type Infer<S> = S extends Schema<infer T> ? T : never;
type Box<T> = { v: T };
type Unbox<S> = { [K in keyof S]: S[K] extends Box<infer T> ? T : never };
type Plain<S> = { [K in keyof S]: S[K] };

function string(): Schema<string> {
  return {
    parse: (input) => {
      if (typeof input !== "string") throw new Error("expected string");
      return input;
    },
  };
}

function number(): Schema<number> {
  return {
    parse: (input) => {
      if (typeof input !== "number") throw new Error("expected number");
      return input;
    },
  };
}

function object<S extends Record<string, Schema<unknown>>>(
  shape: S,
): Schema<{ [K in keyof S]: Infer<S[K]> }> {
  return {
    parse: (input) => {
      if (input === null || typeof input !== "object") throw new Error("expected object");
      const src = input as Record<string, unknown>;
      const fields = shape as Record<string, Schema<unknown>>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(fields)) {
        const field = fields[key];
        if (field !== undefined) out[key] = field.parse(src[key]);
      }
      return out as { [K in keyof S]: Infer<S[K]> };
    },
  };
}

// Two instances of object() with different shapes.
const User = object({ name: string(), age: number() });
const user = User.parse(JSON.parse('{"name":"Ada","age":36}'));
console.log(`${user.name} ${user.age + 1}`);

const Point = object({ x: number(), y: number() });
const p = Point.parse(JSON.parse('{"x":3,"y":4}'));
console.log(Math.sqrt(p.x * p.x + p.y * p.y));

// A schema of schemas.
const Line = object({ from: Point, to: Point, label: string() });
const line = Line.parse(JSON.parse('{"from":{"x":0,"y":0},"to":{"x":6,"y":8},"label":"ab"}'));
console.log(`${line.label} ${line.to.x - line.from.x} ${line.to.y - line.from.y}`);

// The failure path throws from the field's own parse.
try {
  User.parse(JSON.parse('{"name":"Bob","age":"old"}'));
  console.log("accepted");
} catch (e) {
  console.log(e instanceof Error ? e.message : "?");
}

const raw: unknown = JSON.parse('{"a":1}');

// Returned directly.
function unboxed<S>(s: S): Unbox<S> {
  void s;
  return raw as Unbox<S>;
}
console.log(unboxed({ a: { v: 1 } }).a + 1);

// In a record field.
function wrapped<S>(s: S): { out: Unbox<S> } {
  void s;
  return { out: raw as Unbox<S> };
}
console.log(wrapped({ a: { v: 1 } }).out.a + 2);

// As a function member's return, homomorphic and conditional.
function plainGetter<S>(s: S): { get: () => Plain<S> } {
  void s;
  return { get: () => raw as Plain<S> };
}
console.log(plainGetter({ a: 1 }).get().a + 3);

function unboxGetter<S>(s: S): { get: () => Unbox<S> } {
  void s;
  return { get: () => raw as Unbox<S> };
}
console.log(unboxGetter({ a: { v: 1 } }).get().a + 4);

// A bare function return.
function thunk<S>(s: S): () => Plain<S> {
  void s;
  return () => raw as Plain<S>;
}
console.log(thunk({ a: 1 })().a + 5);
