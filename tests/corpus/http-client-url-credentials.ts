// A URL's userinfo becomes the request's Authorization header: Node takes
// decodeURIComponent of the username and password, prefixes them with a
// colon, and passes that as the constructor's auth only when either part is
// non-empty. An options record's auth and an explicit Authorization header
// win over the URL's credentials, and the requests share the global agent.
import * as http from "node:http";

let connections = 0;
const server = http.createServer((req, res) => {
  console.log("got", req.url, "auth=", JSON.stringify(req.headers.authorization));
  res.end("ok");
});
server.on("connection", () => connections++);

function fetchUrl(target: string, options: http.RequestOptions | null, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const cb = (res: http.IncomingMessage): void => {
        res.resume();
        res.on("end", () => resolve());
      };
      const req = options === null ? http.get(target, cb) : http.get(target, options, cb);
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
  const base = `http://user:pa%20ss@127.0.0.1:${port}`;
  await fetchUrl(base + "/url-creds", null, "url");
  await fetchUrl(base + "/url-plus-auth", { auth: "opt:over" }, "url+auth");
  await fetchUrl(base + "/url-plus-header", { headers: { authorization: "Head er" } }, "url+header");
  await fetchUrl(`http://@127.0.0.1:${port}/empty-userinfo`, null, "empty");
  await fetchUrl(`http://:pw@127.0.0.1:${port}/pass-only`, null, "pass-only");
  await fetchUrl(`http://us%20er@127.0.0.1:${port}/encoded-user`, null, "encoded");
  console.log("connections", connections);
  server.close(() => console.log("closed"));
});
