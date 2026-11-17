// http.request's `auth` option becomes the Authorization header ("Basic "
// + base64 of Buffer.from(auth)) after the implicit Host and only over an
// absent Authorization header. Strings, Buffers and Uint8Arrays convert; a
// falsy value leaves the header unset; an explicit Authorization header
// wins; a value Buffer.from rejects throws ERR_INVALID_ARG_TYPE from the
// request constructor, before any connection is dialed.
import * as http from "node:http";

let connections = 0;
const server = http.createServer((req, res) => {
  console.log("got", req.url, "auth=", JSON.stringify(req.headers.authorization));
  res.end("ok");
});
server.on("connection", () => connections++);

function get(options: http.RequestOptions, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const req = http.request({ host: "127.0.0.1", path: "/" + label, ...options }, (res) => {
        res.resume();
        res.on("end", () => {
          console.log(label, "reused", req.reusedSocket);
          resolve();
        });
      });
      req.on("error", (e) => {
        console.log(label, "error", e.message);
        resolve();
      });
      req.end();
    } catch (e) {
      console.log(label, "threw", (e as NodeJS.ErrnoException).code, (e as Error).message);
      resolve();
    }
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  await get({ port, auth: "user:pass" }, "string");
  await get({ port, auth: Buffer.from("u:p") }, "buffer");
  await get({ port, auth: new Uint8Array([117, 58, 112]) }, "u8");
  await get({ port, auth: "" }, "empty");
  await get({ port, auth: "a:b", headers: { authorization: "Custom x" } }, "explicit");
  const num: any = 5;
  await get({ port, auth: num }, "number");
  const obj: any = {};
  await get({ port, auth: obj }, "object");
  const bool: any = true;
  await get({ port, auth: bool }, "bool");
  console.log("connections", connections);
  server.close(() => console.log("closed"));
});
