// request.maxHeadersCount stops Node's parser from adding response header
// lines to res.headers, not from reading them: rawHeaders holds every line,
// and a Content-Length line past the limit still frames the body, so a
// keep-alive response ends instead of hanging on the rest of the connection.
// Two lines that disagree about the framing fail as they would inside the
// limit.
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

function describe(res: http.IncomingMessage): string {
  return (
    `${Object.keys(res.headers).join(",")} | ` +
    `${Object.keys(res.headersDistinct).join(",")} | ` +
    `${"content-length" in res.headersDistinct} | ` +
    `${res.rawHeaders.join(",")}`
  );
}

function get(
  port: number,
  agent: http.Agent | false,
  maxHeadersCount: number,
  body: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const req = http.request(
      { host: "127.0.0.1", port, agent },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => {
          console.log("response", res.statusCode, JSON.stringify(text), describe(res));
          console.log("same connection", req.reusedSocket);
          finish();
        });
      },
    );
    req.maxHeadersCount = maxHeadersCount;
    req.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      console.log("error", e.code, err.message);
      finish();
    });
    req.end(body);
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as net.AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  // Three X-Pad lines fill a maxHeadersCount of 3; Content-Length sits past
  // the cutoff and must still bound the body of 5 bytes.
  scripts.push([
    "HTTP/1.1 200 OK\r\nX-Pad-1: 1\r\nX-Pad-2: 2\r\nX-Pad-3: 3\r\nContent-Length: 5\r\n\r\nhello",
    "HTTP/1.1 200 OK\r\nX-Pad-1: 1\r\nContent-Length: 2\r\n\r\nhi",
  ]);
  console.log("first");
  await get(port, agent, 3, "");
  console.log("second");
  await get(port, agent, 3, "");

  // Duplicate Content-Length past the cutoff: the parser still reads both.
  scripts.push([
    "HTTP/1.1 200 OK\r\nX-Pad-1: 1\r\nX-Pad-2: 2\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx",
  ]);
  console.log("duplicate");
  await get(port, false, 2, "");

  // Content-Length then Transfer-Encoding past the cutoff.
  scripts.push([
    "HTTP/1.1 200 OK\r\nX-Pad-1: 1\r\nX-Pad-2: 2\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\nx",
  ]);
  console.log("conflict");
  await get(port, false, 2, "");

  agent.destroy();
  server.close(() => console.log("closed"));
});
