// The typed form of new TextEncoder(label): @types/node declares no
// constructor parameters, and Node ignores the arguments it is given.
// @ts-expect-error TextEncoder's constructor takes no parameters.
const encoder = new TextEncoder("utf-8");
const strict = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const loose = new TextDecoder("UTF8", { fatal: false });
console.log(encoder.encoding, strict.encoding, strict.fatal, strict.ignoreBOM, loose.ignoreBOM);
const bytes = encoder.encode("\uFEFFh\u00E9");
console.log(JSON.stringify(strict.decode(bytes)), JSON.stringify(loose.decode(bytes)));
// @ts-expect-error TextEncoder's constructor takes no parameters.
const inline = new TextEncoder("latin1").encode("\u00FF");
console.log(Array.from(inline).join(","));
const bad = new Uint8Array([0x61, 0xff, 0x62, 0xc3]);
console.log(JSON.stringify(loose.decode(bad)));
try {
  strict.decode(bad);
} catch (error) {
  const e = error as { name: string; code: string; message: string };
  console.log(e.name, e.code, e.message);
}
for (const label of ["utf-9", "unicode-1-1-utf-8"]) {
  try {
    console.log(new TextDecoder(label, { fatal: true }).encoding);
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log(error instanceof RangeError, e.name, e.code, e.message);
  }
}
const spreadLabels: string[] = ["utf-8", "latin1"];
// @ts-expect-error TextEncoder's constructor takes no parameters.
const spread = new TextEncoder(...spreadLabels);
console.log(spread.encoding, spread.encode("ok").length);
