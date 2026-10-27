// A generic arrow or method held by an object literal returns an object
// whose callback has a defaulted parameter. The callback is typed by the
// declared result (`at?: readonly string[]`), and calls that omit the
// argument use the default, as in Node.
type Codec<T> = { decode: (value: unknown, at?: readonly string[]) => T };
function describe<C extends object>(codec: C): C {
  return codec;
}

const t = {
  literal: <T>(initial: T): Codec<T> =>
    describe({
      decode: (_value: unknown, at: readonly string[] = []): T => {
        console.log("at", at.length === 0 ? "(default)" : at.join("."));
        return initial;
      },
    }),
  pair<A, B>(a: A, b: B): Codec<[A, B]> {
    return { decode: (_value: unknown, at: readonly string[] = ["root"]) => (console.log(at.join(".")), [a, b]) };
  },
};

console.log(t.literal(42).decode(null));
console.log(t.literal("text").decode(null, ["a", "b"]));
const flag = t.literal(true);
console.log(flag.decode(undefined), flag.decode(1, []));
console.log(JSON.stringify(t.pair(1, "x").decode(null)));
console.log(JSON.stringify(t.pair(false, [2]).decode(null, ["p"])));

function literal<T>(initial: T): Codec<T> {
  return describe({ decode: (_value: unknown, _at: readonly string[] = []): T => initial });
}
console.log(literal(7).decode(null));
