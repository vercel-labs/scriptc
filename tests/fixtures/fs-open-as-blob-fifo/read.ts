// fs.openAsBlob over a FIFO: reading the Blob's bytes must not park the
// event loop. Node's blob reader re-opens the path with a blocking open and
// hangs when no writer exists; the compiled runtime reads through the
// descriptor the creation open took, so a zero-size FIFO answers no bytes.
// Usage: read <fifo-path>
import { openAsBlob } from "node:fs";

const blob = await openAsBlob(process.argv[2]!);
let ticked = false;
setTimeout(() => {
  ticked = true;
}, 10);
const bytes = await blob.arrayBuffer();
console.log("read", blob.size, bytes.byteLength, ticked);
