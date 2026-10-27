// Bytes that arrive on an idle pooled socket are not read as the next
// response: the agent destroys the socket, and the next request through
// the agent dials a new connection.
import * as http from "node:http";
import * as net from "node:net";

let conns = 0;
const server = net.createServer((sock) => {
  const id = ++conns;
  let buf = "";
  sock.on("data", (d: Buffer) => {
    buf += d.toString();
    while (buf.includes("\r\n\r\n")) {
      const head = buf.slice(0, buf.indexOf("\r\n\r\n"));
      buf = buf.slice(buf.indexOf("\r\n\r\n") + 4);
      const path = head.split(" ")[1]!;
      const body = `real ${path} conn${id}`;
      sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nKeep-Alive: timeout=5\r\n\r\n${body}`);
      if (path === "/poisoned") {
        setTimeout(() => sock.write("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nPOISON"), 50);
      }
    }
  });
  sock.on("close", () => console.log(`server conn${id} closed`));
  sock.on("error", () => {});
});

const agent = new http.Agent({ keepAlive: true });
function get(port: number, path: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve(`${body} reused=${req.reusedSocket}`));
    });
    req.on("error", (e: Error) => resolve(`error ${e.message}`));
  });
}

function free(): number {
  return Object.keys(agent.freeSockets).length;
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as net.AddressInfo).port;
  console.log(await get(port, "/quiet"));
  await new Promise<void>((r) => setTimeout(r, 20));
  console.log("free after /quiet", free());
  console.log(await get(port, "/again"));
  console.log(await get(port, "/poisoned"));
  await new Promise<void>((r) => setTimeout(r, 200));
  console.log("free after stray bytes", free(), "total", agent.totalSocketCount);
  console.log(await get(port, "/next"));
  console.log("connections", conns);
  agent.destroy();
  server.close(() => console.log("server closed"));
});
