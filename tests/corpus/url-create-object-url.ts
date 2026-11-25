// URL.createObjectURL registers a Blob (or File) under a fresh
// "blob:nodedata:<uuid v4>" id; fetch() of the id resolves the registered
// bytes — 200 OK, the size as Content-Length, the blob's type as
// Content-Type (empty when it has none), and the id as the response URL.
// Revoking one id leaves the others alone, and a revoked or never
// registered id rejects like undici's blob: scheme.
import { File } from "node:buffer";

const shape = /^blob:nodedata:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const describe = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message}`;

async function failure(label: string, input: string): Promise<void> {
  try {
    await fetch(input);
    console.log(label, "resolved");
  } catch (e) {
    console.log(label, describe(e));
  }
}

async function main(): Promise<void> {
  const blob = new Blob(["hello object"], { type: "text/plain" });
  const id = URL.createObjectURL(blob);
  console.log("id", id.slice(0, 14), id.length, shape.test(id));
  const again = URL.createObjectURL(blob);
  console.log("fresh", again !== id, shape.test(again));

  const response = await fetch(id);
  console.log(
    "response",
    response.status,
    response.statusText,
    response.ok,
    response.url === id,
    response.redirected,
  );
  console.log("headers", JSON.stringify([...response.headers]));
  console.log("body", JSON.stringify(await response.text()), response.bodyUsed);

  const file = new File(["file bytes"], "note.txt", { type: "text/csv" });
  const fileId = URL.createObjectURL(file);
  const fromFile = await fetch(fileId);
  console.log("file", JSON.stringify([...fromFile.headers]), JSON.stringify(await fromFile.text()));

  const untypedId = URL.createObjectURL(new Blob(["no type"]));
  const untyped = await fetch(untypedId);
  console.log("untyped", JSON.stringify([...untyped.headers]), JSON.stringify(await untyped.text()));

  const emptyId = URL.createObjectURL(new Blob([]));
  const empty = await fetch(emptyId);
  console.log("empty", JSON.stringify([...empty.headers]), JSON.stringify(await empty.text()));

  const slicedId = URL.createObjectURL(blob.slice(2, 7));
  console.log("slice", JSON.stringify(await (await fetch(slicedId)).text()));

  // fetch strips the fragment from every request URL; the registry key is
  // the serialized URL without it.
  console.log("fragment", (await fetch(`${id}#part`)).url === id);

  // Only GET resolves an object URL; other methods are a fetch failure.
  try {
    await fetch(id, { method: "POST" });
    console.log("post", "resolved");
  } catch (e) {
    console.log("post", describe(e));
  }
  try {
    await fetch(id, { method: "HEAD" });
    console.log("head", "resolved");
  } catch (e) {
    console.log("head", describe(e));
  }

  URL.revokeObjectURL(again);
  await failure("revoked", again);
  console.log("kept", (await fetch(id)).status, JSON.stringify(await (await fetch(id)).text()));

  URL.revokeObjectURL(id);
  URL.revokeObjectURL(new URL(fileId));
  await failure("gone", id);
  await failure("gone-file", fileId);
  await failure("unknown", "blob:nodedata:00000000-0000-4000-8000-000000000000");

  // The scheme is case-insensitive but the path — and so the key — is not.
  const titled = URL.createObjectURL(new Blob(["case"]));
  await failure("uppercase", titled.toUpperCase());
  await failure("query", `${titled}?q=1`);
  await failure("trailing-slash", `${titled}/`);
  console.log("still", (await fetch(titled)).status);
}

void main();
