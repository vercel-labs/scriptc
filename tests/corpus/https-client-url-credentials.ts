// https.get(url) parses the URL's userinfo the way http.get does: the
// decoded "user:pass" rides the constructor's auth option only when either
// part is non-empty, an options record's auth wins over it, an explicit
// Authorization header wins over both, and the requests share
// https.globalAgent.
import { readFileSync } from "node:fs";
import * as https from "node:https";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

let connections = 0;
const server = https.createServer({ cert, key }, (req, res) => {
  console.log("got", req.url, "auth=", JSON.stringify(req.headers.authorization));
  res.end("ok");
});
server.on("connection", () => connections++);

function fetchUrl(target: string, options: https.RequestOptions | null, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const cb = (res: import("node:http").IncomingMessage): void => {
        res.resume();
        res.on("end", () => resolve());
      };
      const req = options === null ? https.get(target, cb) : https.get(target, options, cb);
      req.on("error", (e) => {
        console.log(label, "error", e.message);
        resolve();
      });
    } catch (e) {
      console.log(label, "threw", (e as NodeJS.ErrnoException).code, (e as Error).message);
      resolve();
    }
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  const base = `https://user:pa%20ss@127.0.0.1:${port}`;
  await fetchUrl(base + "/url-creds", { ca }, "url");
  await fetchUrl(base + "/url-plus-auth", { ca, auth: "opt:over" }, "url+auth");
  await fetchUrl(
    base + "/url-plus-header",
    { ca, headers: { authorization: "Head er" } },
    "url+header",
  );
  await fetchUrl(`https://@127.0.0.1:${port}/empty-userinfo`, { ca }, "empty");
  await fetchUrl(`https://:pw@127.0.0.1:${port}/pass-only`, { ca }, "pass-only");
  console.log("connections", connections);
  server.close(() => console.log("closed"));
});
