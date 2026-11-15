// fetch() with a Blob or File request body: extractBody sends the blob's
// bytes, and a non-empty Blob type becomes Content-Type unless the request
// sets one. Request and Response take the same bodies.
import http from "node:http";
import { File } from "node:buffer";

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        contentType: req.headers["content-type"] ?? null,
        contentLength: req.headers["content-length"] ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/echo`;

const post = async (init) => {
  const response = await fetch(base, { method: "POST", ...init });
  console.log(await response.text());
};

await post({ body: new Blob(["hello blob"], { type: "text/plain" }) });
await post({ body: new Blob(["no type"]) });
await post({ body: new File(["file bytes"], "note.txt", { type: "application/octet-stream" }) });
await post({ body: new Blob(["override"]), headers: { "content-type": "application/json" } });

const request = new Request(base, {
  method: "POST",
  body: new Blob(["request body"], { type: "text/plain" }),
});
console.log("request content-type", request.headers.get("content-type"));

const response = new Response(new Blob(["response body"], { type: "text/plain" }));
console.log("response content-type", response.headers.get("content-type"), await response.text());
server.close();
