// String conversions of unions whose object arms are URLs, typed arrays,
// dates and regular expressions: String(), template literals and `+` with
// a string convert each arm as it converts alone, as in Node.
const source = (n: number): URL | Uint8Array =>
  n > 0 ? new URL("https://cdn.dev/clip.mp3?v=2#t") : new Uint8Array([1, 2, 3]);
for (const n of [1, 0]) {
  const v = source(n);
  console.log(String(v), `${v}`, "source=" + v);
}

const when = (n: number): Date | string => (n > 0 ? new Date(Date.UTC(2020, 0, 15, 12)) : "later");
for (const n of [1, 0]) {
  const v = when(n);
  console.log(String(v).slice(0, 15), `${v}`.slice(0, 15), ("at " + v).slice(0, 10));
}

const pattern = (n: number): RegExp | number | undefined => (n > 1 ? /a+b/gi : n > 0 ? 42 : undefined);
for (const n of [2, 1, 0]) {
  const v = pattern(n);
  console.log(String(v), `${v}`, "p" + v);
}

// A Buffer in a Uint8Array arm keeps its own toString.
const bytes = (n: number): Uint8Array | null => (n > 0 ? Buffer.from("hi") : null);
for (const n of [1, 0]) console.log(String(bytes(n)), `${bytes(n)}`, "b" + bytes(n));

// Narrowed by instanceof on a property of a parameter.
function describe(options: { source?: URL | Uint8Array }): string {
  if (options.source instanceof Uint8Array) return "u8[" + options.source.length + "]";
  if (options.source instanceof URL) return "url " + String(options.source);
  return "none";
}
console.log(describe({ source: source(1) }), describe({ source: source(0) }), describe({}));
