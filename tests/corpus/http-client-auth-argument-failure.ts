// A request that fails its own argument checks after the auth option was
// staged must release the credentials: the next request on the same thread
// is auth-less and must reach the server without an Authorization header.
// The failures are the ones Node throws synchronously from the constructor
// (the path check and each header's content check).
import * as http from "node:http";
import * as net from "node:net";

const seen: string[] = [];

const server = http.createServer((request, response) => {
  seen.push(String(request.headers.authorization));
  response.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  try {
    http.request({ host: "127.0.0.1", port, path: "/bad path", auth: "user:pass" });
    console.log("path: no throw");
  } catch {
    console.log("path: threw");
  }
  try {
    http.request({ host: "127.0.0.1", port, auth: "user:pass", headers: { "X-Bad": "a\rb" } });
    console.log("header: no throw");
  } catch {
    console.log("header: threw");
  }
  http
    .get({ host: "127.0.0.1", port }, (response) => {
      response.resume();
      response.on("end", () => {
        console.log("authorization", JSON.stringify(seen));
        server.close(() => console.log("closed"));
      });
    })
    .on("error", (error) => console.log("client error", error.message));
});
