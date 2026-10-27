// A socket's 'lookup' event for a host name (none for an IP address),
// string 'data' listeners after setEncoding on both sides of an HTTP
// exchange, res.end() of a string or undefined, and the close callback of
// a server that never listened.
import * as http from "node:http";
import * as net from "node:net";

function lookups(): Promise<void> {
  return new Promise<void>((resolve) => {
    const tcp = net.createServer((s) => s.end("hi"));
    tcp.listen(0, "127.0.0.1", () => {
      const port = (tcp.address() as net.AddressInfo).port;
      const named = net.connect({ host: "localhost", port });
      let reported = false;
      named.on("lookup", (err: Error | null, address: string, family: number, host: string) => {
        // macOS also answers ::1; report the IPv4 answer the dial uses.
        if (family === 4 && !reported) {
          reported = true;
          console.log("lookup", err, address, family, host);
        }
      });
      named.once("connect", () => console.log("connect after lookup", reported));
      named.on("data", () => {});
      named.on("close", () => {
        const direct = net.connect({ host: "127.0.0.1", port });
        // A 'lookup' listener that never runs and holds its socket: closing
        // the socket drops it.
        direct.once("lookup", () => console.log("unexpected lookup", direct.remotePort));
        direct.once("connect", () => console.log("connect without lookup"));
        direct.on("data", () => {});
        direct.on("close", () => tcp.close(() => resolve()));
      });
    });
  });
}

const server = http.createServer((req, res) => {
  req.setEncoding("utf8");
  const chunks: string[] = [];
  req.on("data", (chunk: string) => chunks.push(chunk));
  req.on("end", () => {
    const body = chunks.join("");
    res.writeHead(200, { "content-type": "text/plain" });
    const payload = body ? body.toUpperCase() : undefined;
    res.end(payload);
  });
});

function post(port: number, body: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/" }, (res) => {
      res.setEncoding("utf8");
      let text = "";
      res.on("data", (part: string) => {
        text += part;
      });
      res.on("end", () => {
        console.log("response", JSON.stringify(body), "->", JSON.stringify(text));
        resolve();
      });
    });
    req.end(body);
  });
}

lookups().then(() => {
  server.listen(0, "127.0.0.1", async () => {
    const port = (server.address() as net.AddressInfo).port;
    await post(port, "hello");
    await post(port, "");
    server.close(() => console.log("closed"));
    const idle = http.createServer();
    idle.close(() => console.log("never listened closed"));
  });
});
