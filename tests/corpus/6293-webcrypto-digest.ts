// crypto.subtle.digest over the SHA-1 and SHA-2 hashes: string and object
// algorithm identifiers, typed-array, Buffer and ArrayBuffer input, and
// Node's rejections for unknown names and non-buffer data.
const encoder = new TextEncoder();
const input = encoder.encode("scriptc digest input");

function hex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

for (const name of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
  const digest = await crypto.subtle.digest(name, input);
  console.log(name, digest.byteLength, hex(digest));
}
console.log(hex(await crypto.subtle.digest({ name: "sha-256" }, Buffer.from("scriptc digest input"))));
console.log(hex(await crypto.subtle.digest("SHA-256", input.slice().buffer)));
console.log(hex(await crypto.subtle.digest("SHA-256", new Uint8Array(0))));

async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(label, "resolved");
  } catch (e) {
    if (e instanceof DOMException) {
      const error = e as DOMException;
      console.log(label, error.name, error.code, error.message, "DOMException");
    } else {
      const error = e as Error & { code?: string };
      console.log(label, error.name, error.code, error.message);
    }
  }
}

await attempt("md5", () => crypto.subtle.digest("MD5", input));
await attempt("string data", () => crypto.subtle.digest("SHA-256", "text" as unknown as BufferSource));
