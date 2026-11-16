// crypto.subtle.digest with the experimental SHA-3 digests: SHA3-256, SHA3-384 and SHA3-512, named as strings and as algorithms, over the empty input and a longer one. Each digest warns once per process, as Node does, so the program uses every one twice.
// @normalize-pid
const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");
const data = Buffer.from("abc");

for (const name of ["SHA3-256", "SHA3-384", "SHA3-512"]) {
  const digest = await crypto.subtle.digest(name, data);
  const again = await crypto.subtle.digest({ name }, new Uint8Array(0));
  console.log(name, digest.byteLength, hex(digest), again.byteLength, hex(again).slice(0, 16));
}

const lower = await crypto.subtle.digest("sha3-256", Buffer.from("The quick brown fox jumps over the lazy dog"));
console.log("sha3-256 text", hex(lower));

const missing = await crypto.subtle
  .digest({ name: "SHA3-256" } as unknown as AlgorithmIdentifier, data)
  .then((value) => value.byteLength, (error: Error) => `${error.name} ${error.message}`);
console.log("object form", missing);

const unknown = await crypto.subtle
  .digest("SHA3-224", data)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("unknown", unknown);
