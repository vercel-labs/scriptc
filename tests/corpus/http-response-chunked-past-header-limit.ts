// A Transfer-Encoding: chunked line past request.maxHeadersCount still makes
// the client de-chunk the body: Node's parser reads every line of the head
// and only the headers snapshot stops at the limit. The listener gets the
// payload, not the wire framing, and a keep-alive connection hands the next
// response to its request.
import * as http from "node:http";
import * as net from "node:net";

const scripts: string[][] = [];

const server = net.createServer((socket) => {
  const script = scripts.shift() ?? [];
  let buf = "";
  let index = 0;
  socket.on("data", (chunk: Buffer) => {
    buf += chunk.toString("latin1");
    while (index < script.length) {
      const at = buf.indexOf("\r\n\r\n");
      if (at === -1) return;
      buf = buf.slice(at + 4);
      socket.write(script[index++]!);
    }
  });
});

function get(port: number, agent: http.Agent | false, maxHeadersCount: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const req = http.request({ host: "127.0.0.1", port, agent }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c.toString()));
      res.on("end", () => {
        console.log("response", res.statusCode, JSON.stringify(text));
        console.log("headers", Object.keys(res.headers).join(","));
        console.log("raw", res.rawHeaders.join(","));
        console.log("reused", req.reusedSocket);
        finish();
      });
    });
    req.maxHeadersCount = maxHeadersCount;
    req.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      console.log("error", e.code, err.message);
      finish();
    });
    req.end();
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as net.AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  // Two X-Pad lines reach a maxHeadersCount of 2; the chunked coding comes
  // after them, so the body must still arrive de-chunked.
  scripts.push([
    "HTTP/1.1 200 OK\r\nX-Pad-1: 1\r\nX-Pad-2: 2\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nX-Pad-1: 1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n",
  ]);
  console.log("first");
  await get(port, agent, 2);
  console.log("second");
  await get(port, agent, 2);

  // Chunked with trailers, all of it after the cutoff.
  scripts.push([
    "HTTP/1.1 200 OK\r\nX-Pad-1: 1\r\nX-Pad-2: 2\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n0\r\nX-Trail: t\r\n\r\n",
  ]);
  console.log("trailers");
  await get(port, false, 2);

  agent.destroy();
  server.close(() => console.log("closed"));
});
