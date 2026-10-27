// Aliases of the global Buffer constructor read through a cast of
// globalThis, the capability-probe spelling of code that also runs where
// Buffer is absent: typed and `as any` casts, `if`, ternary, typeof and `!`
// guards, member calls through the alias, and typeof of the alias.
type RuntimeBuffer = {
  byteLength(value: string, encoding: "utf8"): number;
  from(value: string, encoding: "utf8"): Uint8Array;
  isBuffer(value: unknown): boolean;
};

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
const anyBuffer = (globalThis as any).Buffer;
const text = "héllo wörld";

if (runtimeBuffer) {
  console.log("typed", runtimeBuffer.byteLength(text, "utf8"));
} else {
  console.log("typed: no Buffer");
}
if (typeof anyBuffer === "function") {
  console.log("any", anyBuffer.byteLength(text, "utf8"));
}
const bytes = runtimeBuffer ? runtimeBuffer.from(text, "utf8") : undefined;
console.log("from", bytes ? bytes.length : -1);
console.log("isBuffer", runtimeBuffer ? runtimeBuffer.isBuffer(bytes) : false);
console.log("typeof", typeof runtimeBuffer, typeof anyBuffer, !runtimeBuffer);

function utf8Length(value: string): number {
  return runtimeBuffer ? runtimeBuffer.byteLength(value, "utf8") : value.length;
}
console.log("function", utf8Length("✓✓"), utf8Length("abc"));

// A copy of an alias, and an alias whose cast read is guarded with `||`,
// alias the same constructor.
const copied = runtimeBuffer;
const fallback: RuntimeBuffer = {
  byteLength: (value: string) => value.length,
  from: (value: string) => new Uint8Array(value.length),
  isBuffer: () => false,
};
const orFallback = (globalThis as { Buffer?: RuntimeBuffer }).Buffer || fallback;
console.log("copy", copied ? copied.byteLength(text, "utf8") : -1, typeof copied, !copied);
console.log("or", orFallback.byteLength(text, "utf8"), orFallback.isBuffer(bytes), typeof orFallback);
