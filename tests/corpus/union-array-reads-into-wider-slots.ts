// Elements of a (Uint8Array | string)[] read into slots that also accept
// undefined: present elements keep their value, past the end reads undefined.
const chunks: (Uint8Array | string)[] = ["a", new Uint8Array([98, 99]), "d"];
function describe(chunk: Uint8Array | string | undefined): string {
  if (chunk === undefined) return "undefined";
  return typeof chunk === "string" ? `s:${chunk}` : `b:${chunk.length}`;
}
const out: string[] = [];
for (let i = 0; i <= chunks.length; i++) out.push(describe(chunks[i]));
console.log(out.join(" "));
function exact(chunk: Uint8Array | string): number {
  return typeof chunk === "string" ? chunk.length : chunk.byteLength;
}
let total = 0;
for (let i = 0; i < chunks.length; i++) total += exact(chunks[i]!);
console.log(total);
