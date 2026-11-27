// Many parameter names of one length: every probe the de-duplication set
// makes is decided by its keyed hash, and the parse stays proportional to
// the header.
const body = () => new Uint8Array([104, 105]);
const pairs = Array.from({ length: 50000 }, (_, i) => `q${String(i).padStart(5, "0")}=${i}`);
const blob = await new Response(body(), {
  headers: { "content-type": `text/plain; ${pairs.join("; ")}` },
}).blob();
const type = blob.type;
console.log(
  `equal ${type.length} ${type.startsWith("text/plain;q00000=0;q00001=1")} ${type.endsWith("q49999=49999")} ${blob.size}`,
);
