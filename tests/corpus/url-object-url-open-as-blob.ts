// A program whose only Blob use is fs.openAsBlob's answer: the Blob goes
// straight to URL.createObjectURL, and fetch() of that id answers the file's
// bytes — and, once the file is gone, a 200 response whose body read rejects
// with the Blob's NotReadableError — with no other Blob member call in the
// program to pull in the fetch unit's Blob body build.
import { mkdtempSync, openAsBlob, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-blob-url-only-"));
const file = join(dir, "a.txt");
writeFileSync(file, "file bytes");
const blob = await openAsBlob(file, { type: "text/plain" });
const id = URL.createObjectURL(blob);

const response = await fetch(id);
console.log(
  response.status,
  response.statusText,
  response.url === id,
  JSON.stringify([...response.headers]),
  JSON.stringify(await response.text()),
);

rmSync(file);
const gone = await fetch(id);
console.log(gone.status, gone.ok, JSON.stringify([...gone.headers]));
try {
  console.log(JSON.stringify(await gone.text()));
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

rmSync(dir, { recursive: true, force: true });
