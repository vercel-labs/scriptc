// new Response(blob) extracts the blob's body without reading it: a
// file-backed Blob whose file changed after openAsBlob still lets the
// Response construct (200), and the body's read rejects with the blob's
// NotReadableError — the same error a direct read of the blob gives.
import { openAsBlob } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-blob-response-"));
const file = join(dir, "file.txt");
writeFileSync(file, "hello");

const readable = await openAsBlob(file);
const good = new Response(readable);
console.log("readable", good.status, JSON.stringify(await good.text()));

const stale = await openAsBlob(file);
writeFileSync(file, "changed content longer");
const response = new Response(stale);
console.log("stale constructed", response.status);
try {
  console.log("stale text", JSON.stringify(await response.text()));
} catch (error) {
  console.log("stale text error", (error as Error).name, (error as Error).message);
}

// The body stream carries the blob's error as its reason: a fresh response's
// reader sees it too.
const stale2 = await openAsBlob(file);
const response2 = new Response(stale2);
const reader = response2.body!.getReader();
try {
  const chunk = await reader.read();
  const bytes = chunk.value === undefined ? [] : Array.from(chunk.value);
  console.log("stale read", bytes.length, bytes.join(","), chunk.done);
} catch (error) {
  console.log("stale read error", (error as Error).name, (error as Error).message);
}

// A plain in-memory Blob keeps working alongside the file-backed path.
const memory = new Blob(["abc"]);
console.log("memory", memory.size, JSON.stringify(await new Response(memory).text()));
console.log("file", readFileSync(file, "utf8"));

rmSync(dir, { recursive: true, force: true });
