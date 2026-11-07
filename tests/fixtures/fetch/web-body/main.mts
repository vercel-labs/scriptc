// Blob and File request bodies: extractBody sends the blob's bytes, and a
// non-empty Blob type becomes Content-Type when the request sets none. The
// /post-echo route reports the method, content type, content length and
// body it received, so Node and the native runtime must agree on the wire.
import { File as BufferFile } from "node:buffer";

const post = async (init: RequestInit): Promise<void> => {
  const response = await fetch(`${process.argv[2]}/post-echo`, { method: "POST", ...init });
  console.log(await response.text());
};

const blob = new Blob(["hello blob"], { type: "text/plain" });
await post({ body: blob });
await post({ body: new Blob(["no type"]) });
const file = new BufferFile(["file bytes"], "note.txt", { type: "application/octet-stream" });
await post({ body: file });
await post({ body: blob, headers: { "content-type": "application/json" } });

// The same body through the Request and Response constructors.
const request = new Request(`${process.argv[2]}/post-echo`, { method: "POST", body: file });
console.log("request content-type", request.headers.get("content-type"));
const response = new Response(blob);
console.log("response content-type", response.headers.get("content-type"));
console.log("response body", await response.text());
const bare = new Response(new Blob(["x"]));
console.log("bare content-type", bare.headers.get("content-type"));
