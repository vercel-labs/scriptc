// Typed arrays the checker types `any` in package JavaScript: hono's etag
// digest (hono/dist/middleware/etag/digest.js) merges multi-chunk bodies
// through `nextChunk.set(...)`, where `nextChunk`'s initializer depends on
// `chunk`, which is assigned `nextChunk`. Method calls and property reads on
// such values run on the native bytes, as in Node.
import { generateDigest } from "etag-digest";
import { grow } from "chunk-buffers";

const enc = new TextEncoder();
const sha1 = (body: Uint8Array): Promise<ArrayBuffer> => crypto.subtle.digest({ name: "SHA-1" }, body);

function chunked(parts: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (i < parts.length) controller.enqueue(enc.encode(parts[i++]!));
      else controller.close();
    },
  });
}

async function main(): Promise<void> {
  console.log("single", await generateDigest(chunked([JSON.stringify({ books: 400 })]), sha1));
  console.log("chunked", await generateDigest(chunked(["alpha\n", "beta\n", "gamma\n", "delta\n"]), sha1));
  const large = ["x".repeat(200000), "y".repeat(100000), "z".repeat(5)];
  console.log("large", await generateDigest(chunked(large), sha1));
  console.log("exact", await generateDigest(chunked(["a".repeat(262144), "b"]), sha1));
  console.log("empty", await generateDigest(chunked([]), sha1));
  console.log("null", await generateDigest(null, sha1));
  console.log(grow([new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array([5])]));
}

await main();
