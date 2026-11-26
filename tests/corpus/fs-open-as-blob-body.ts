// A file-backed Blob used as a fetch or Request body contributes its type as
// the automatic Content-Type the way Node's Headers does: surrounding HTTP
// whitespace is trimmed, and a value carrying CR, LF or NUL rejects the
// request with Node's Headers.append TypeError instead of splitting it into
// extra headers.
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openAsBlob } from "node:fs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-body-"));
const file = path.join(dir, "body.bin");
fs.writeFileSync(file, "hi");

// Building an ordinary Blob selects the fetch unit's Blob body support.
const marker = new Blob(["x"]);
console.log("marker", marker.size);

const crlf = await openAsBlob(file, { type: "text/plain\r\nX-Injected: yes" });
try {
  const request = new Request("http://127.0.0.1:9/", { method: "POST", body: crlf });
  console.log("request ok", JSON.stringify(request.headers.get("content-type")));
} catch (error) {
  const e = error as Error;
  console.log("request threw", e.name, JSON.stringify(e.message));
}
try {
  await fetch("http://127.0.0.1:9/", { method: "POST", body: crlf });
  console.log("fetch ok");
} catch (error) {
  const e = error as Error;
  console.log("fetch threw", e.name, JSON.stringify(e.message));
}

// An explicit Content-Type header wins, and Node does not validate the
// blob's unused type then.
try {
  const explicit = new Request("http://127.0.0.1:9/", {
    method: "POST",
    body: crlf,
    headers: { "content-type": "text/plain" },
  });
  console.log("explicit ok", JSON.stringify(explicit.headers.get("content-type")));
} catch (error) {
  const e = error as Error;
  console.log("explicit threw", e.name, JSON.stringify(e.message));
}

// Surrounding whitespace is trimmed; the body still reaches the server.
const spaced = await openAsBlob(file, { type: "  text/plain  " });
const server = http.createServer((req, res) => {
  console.log("server type", JSON.stringify(req.headers["content-type"]), "injected", JSON.stringify(req.headers["x-injected"]));
  res.end("ok");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const response = await fetch("http://127.0.0.1:" + String(port) + "/", {
  method: "POST",
  body: spaced,
});
console.log("spaced status", response.status);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
