// A Host header given as an array must not get past the checks: directly the
// request refuses it (Node's ERR_INVALID_ARG_TYPE), and through the module's
// proxy the value is compared against the authority however it was given — an
// array or a duplicate name cannot smuggle a different Host past the proxy.
import * as http from "node:http";
import * as net from "node:net";

const proxyHits: string[] = [];
const proxy = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk: Buffer) => {
    buf += chunk.toString("latin1");
    if (buf.includes("\r\n\r\n")) {
      proxyHits.push(buf.split("\r\n")[0] ?? "");
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nproxy");
    }
  });
});

const server = http.createServer((req, res) => {
  console.log("server host", req.headers.host);
  res.end("direct");
});

let normalize = (text: string): string => text;

function report(label: string, error: unknown): void {
  const caught = error as NodeJS.ErrnoException;
  console.log(label, caught.code, normalize(caught.message));
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const auth = "127.0.0.1:" + port;
  // the ephemeral port differs between the Node and compiled runs
  normalize = (text: string): string => text.split(String(port)).join("<port>");

  // no proxy: an array under host is refused before anything is dialed
  try {
    const request = http.request({ port, host: "127.0.0.1", headers: { host: [auth] } });
    request.on("error", () => {});
    request.end();
    console.log("direct array accepted");
  } catch (error) {
    report("direct array", error);
  }

  // a later scalar spelling replaces the array, so this one is allowed
  const replaced = http.request(
    {
      port,
      host: "127.0.0.1",
      headers: { host: [auth], Host: "127.0.0.1" },
    },
    (res) => {
      res.resume();
      res.on("end", () => console.log("array then scalar", res.statusCode));
    },
  );
  replaced.on("error", (error) => console.log("array then scalar error", (error as NodeJS.ErrnoException).code));
  replaced.end();

  // the other way round the array is the value kept, and it is refused
  try {
    const request = http.request({
      port,
      host: "127.0.0.1",
      headers: { Host: "127.0.0.1", host: [auth] },
    });
    request.on("error", () => {});
    request.end();
    console.log("scalar then array accepted");
  } catch (error) {
    report("scalar then array", error);
  }

  proxy.listen(0, "127.0.0.1", () => {
    const proxyPort = (proxy.address() as { port: number }).port;
    http.setGlobalProxyFromEnv({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });

    // proxied: a two-element array does not match the authority
    try {
      const request = http.request({
        port,
        host: "127.0.0.1",
        path: "/array",
        headers: { host: [auth, "elsewhere"] },
      });
      request.on("error", () => {});
      request.end();
      console.log("proxy array accepted");
    } catch (error) {
      report("proxy array", error);
    }

    // proxied: a duplicate name with another value is the effective one
    try {
      const request = http.request({
        port,
        host: "127.0.0.1",
        path: "/dup",
        headers: { Host: auth, host: "elsewhere" },
      });
      request.on("error", () => {});
      request.end();
      console.log("proxy duplicate accepted");
    } catch (error) {
      report("proxy duplicate", error);
    }

    // proxied: a one-element array that matches the authority is fine
    const request = http.request(
      {
        port,
        host: "127.0.0.1",
        path: "/match",
        headers: { host: [auth] },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          console.log("proxy match", res.statusCode, body, normalize(proxyHits.join("|")));
          proxy.close();
          server.close();
        });
      },
    );
    request.on("error", (error) => console.log("proxy match error", (error as NodeJS.ErrnoException).code));
    request.end();
  });
});
