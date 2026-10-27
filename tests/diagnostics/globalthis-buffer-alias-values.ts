// An alias of the Buffer global read through a cast of globalThis compiles
// in conditions, typeof and member calls
// (tests/corpus/7309-globalthis-buffer-aliases.ts). Its other value uses
// keep a named SC1090 refusal: the alias has the cast's static type.
type RuntimeBuffer = { from(value: string, encoding: "utf8"): Uint8Array };
const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
function keep(value: unknown): unknown {
  return value;
}
const bytes = runtimeBuffer && runtimeBuffer.from("abc", "utf8");
keep(runtimeBuffer);
keep(bytes);
// A copy of the alias, and an alias whose cast read is guarded with `||`,
// carry the cast's type too.
const copied = runtimeBuffer;
const orFallback = (globalThis as { Buffer?: RuntimeBuffer }).Buffer || { from: () => new Uint8Array(0) };
keep(copied);
keep(orFallback);
