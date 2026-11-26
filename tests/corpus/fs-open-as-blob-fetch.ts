// An fs.openAsBlob result is a Blob, and handing it to fetch (or to a
// Response/Request constructor) uses the file's bytes and its type: the
// program never builds another Blob, so the fetch Blob body build must be
// selected from openAsBlob itself.
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAsBlob } from "node:fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-fetch-"));
const file = path.join(dir, "f.bin");
fs.writeFileSync(file, "hello-file");

const asResponse = new Response(await openAsBlob(file, { type: "text/plain" }));
console.log(
  "response",
  JSON.stringify(asResponse.headers.get("content-type")),
  JSON.stringify(await asResponse.text())
);

const asRequest = new Request("http://127.0.0.1:9/", {
  method: "POST",
  body: await openAsBlob(file, { type: "text/plain" }),
});
console.log(
  "request",
  JSON.stringify(asRequest.headers.get("content-type")),
  JSON.stringify(await asRequest.text())
);

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    console.log(
      "server",
      JSON.stringify(req.headers["content-type"]),
      JSON.stringify(Buffer.concat(chunks).toString())
    );
    res.end("ok");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const blob = await openAsBlob(file, { type: "text/plain" });
const response = await fetch("http://127.0.0.1:" + String(port) + "/", {
  method: "POST",
  body: blob,
});
console.log("status", response.status);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
