// fetch() of a URL.createObjectURL id whose Blob is file-backed
// (fs.openAsBlob): the response carries the file's bytes, the snapshot size
// as Content-Length and the Blob's type as Content-Type. A file that changed
// or disappeared after openAsBlob still resolves that 200 response — the
// headers are the snapshot's — and consuming the body rejects with the
// Blob's NotReadableError, the error a direct read of the Blob gives.
import { mkdtempSync, openAsBlob, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-blob-url-"));
const file = join(dir, "a.txt");
const other = join(dir, "b.txt");
writeFileSync(file, "hello blob");
writeFileSync(other, "second");

const clean = (text: string): string => text.split(dir).join("<dir>");
const describe = (error: unknown): string => {
  const e = error as { name: string; message: string };
  return `${e.name}: ${clean(e.message)}`;
};
const headers = (response: Response): string => JSON.stringify([...response.headers]);

// Await a body read, printing its text or the rejection it answers.
async function readBody(label: string, response: Response): Promise<void> {
  try {
    console.log(label, JSON.stringify(await response.text()));
  } catch (error) {
    console.log(label, describe(error));
  }
}

async function fetching(label: string, id: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(id, init);
  console.log(
    label,
    response.status,
    response.statusText,
    response.ok,
    response.url === id,
    headers(response),
  );
  return response;
}

async function main(): Promise<void> {
  // A readable file-backed Blob answers its bytes and snapshot metadata.
  const blob = await openAsBlob(file, { type: "text/plain" });
  const id = URL.createObjectURL(blob);
  const response = await fetching("readable", id);
  await readBody("readable body", response);
  console.log("readable bodyUsed", response.bodyUsed);

  // A Blob with no type sends an empty Content-Type.
  const untyped = URL.createObjectURL(await openAsBlob(file));
  await readBody("untyped body", await fetching("untyped", untyped));

  // A Blob built from several files answers their concatenation, and a slice
  // of a file-backed Blob reads that range of the file.
  const composite = new Blob([await openAsBlob(file), await openAsBlob(other)]);
  const compositeId = URL.createObjectURL(composite);
  console.log("composite size", composite.size);
  await readBody("composite", await fetching("composite", compositeId));

  const sliced = URL.createObjectURL(blob.slice(1, 5));
  await readBody("slice", await fetching("slice", sliced));

  // The file disappears after openAsBlob: the fetch resolves 200 with the
  // snapshot's headers, and every consumer of the body rejects with the
  // NotReadableError instead of crashing or answering stale bytes. Each
  // fetch of the same id builds a fresh response with its own body.
  const removed = await openAsBlob(file, { type: "text/plain" });
  const removedId = URL.createObjectURL(removed);
  rmSync(file);
  const removedResponse = await fetching("removed", removedId);
  await readBody("removed body", removedResponse);
  console.log("removed bodyUsed", removedResponse.bodyUsed);
  const again = await fetching("removed again", removedId);
  try {
    console.log("removed again bytes", (await again.arrayBuffer()).byteLength);
  } catch (error) {
    console.log("removed again bytes", describe(error));
  }
  try {
    await removed.text();
  } catch (error) {
    console.log("removed blob read", describe(error));
  }

  // The body stream, a reader of it, and clone() carry the same error as
  // text(); consuming any of them marks the response used.
  const streamed = await fetching("removed stream", removedId);
  const reader = streamed.body!.getReader();
  try {
    const chunk = await reader.read();
    console.log("removed stream read", chunk.done);
  } catch (error) {
    console.log("removed stream read", describe(error));
  }
  console.log("removed stream used", streamed.bodyUsed);
  const cloned = await fetching("removed clone", removedId);
  try {
    await cloned.clone().text();
  } catch (error) {
    console.log("removed clone read", describe(error));
  }
  try {
    await cloned.text();
  } catch (error) {
    console.log("removed clone original", describe(error));
  }

  // A composite Blob with a missing part and a slice of the missing file
  // fail the same way, and an in-memory part beside a missing file part does
  // not deliver its bytes first: the whole read rejects.
  await readBody("composite missing", await fetching("composite missing", compositeId));
  await readBody("slice missing", await fetching("slice missing", sliced));
  const mixed = new Blob(["mem", removed]);
  await readBody("mixed missing", await fetching("mixed missing", URL.createObjectURL(mixed)));

  // Only GET resolves an object URL, so another method is a fetch failure
  // without reading the Blob at all.
  try {
    const post = await fetching("removed post", removedId, { method: "POST" });
    console.log("removed post resolved", post.status);
  } catch (error) {
    console.log("removed post rejected", describe(error));
  }

  // A file replaced behind the Blob's path is a different object even when
  // its size and bytes match, and a file whose size changed is refused: both
  // reject the read.
  writeFileSync(file, "hello blob");
  const replaced = await openAsBlob(file);
  const replacedId = URL.createObjectURL(replaced);
  rmSync(file);
  writeFileSync(file, "hello blob");
  await readBody("replaced", await fetching("replaced", replacedId));

  const resized = await openAsBlob(file);
  const resizedId = URL.createObjectURL(resized);
  writeFileSync(file, "hello blob and more");
  await readBody("resized", await fetching("resized", resizedId));

  // A failure leaves the registry intact: a Blob that still reads answers.
  writeFileSync(file, "hello blob");
  const fresh = URL.createObjectURL(await openAsBlob(file));
  await readBody("fresh", await fetching("fresh", fresh));

  rmSync(dir, { recursive: true, force: true });
}

void main();
