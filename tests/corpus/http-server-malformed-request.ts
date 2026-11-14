// A malformed request line or header on a raw socket: 'clientError'
// reports the parser error (its code, byte count, and raw packet) to the
// listener, a listener that answers writes its own 400, and a server with
// no listener sends the default 400 Bad Request before closing.
import * as net from "node:net";
import * as http from "node:http";

interface RawReply {
  text: string;
  closed: boolean;
}

const rawRequest = (port: number, bytes: string): Promise<RawReply> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(bytes);
    });
    let text = "";
    let closed = false;
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("close", () => {
      closed = true;
      resolve({ text, closed });
    });
    socket.on("error", () => {});
  });

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

void (async () => {
  const handled = http.createServer((_req, res) => res.end("unreachable"));
  handled.on("clientError", (err, socket) => {
    const e = err as NodeJS.ErrnoException;
    console.log("clientError", e.code, e.message);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  const handledPort = await listen(handled);
  const badHeader = await rawRequest(handledPort, "GET / HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n");
  console.log("handled reply", JSON.stringify(badHeader.text), badHeader.closed);
  handled.close();

  const fallback = http.createServer((_req, res) => res.end("unreachable"));
  const fallbackPort = await listen(fallback);
  const badMethod = await rawRequest(fallbackPort, "GE T / HTTP/1.1\r\nHost: x\r\n\r\n");
  console.log("fallback reply", JSON.stringify(badMethod.text), badMethod.closed);
  fallback.close();

  const plain = http.createServer((_req, res) => res.end("ok"));
  const plainPort = await listen(plain);
  const good = await rawRequest(plainPort, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  console.log(
    "good reply",
    good.text.startsWith("HTTP/1.1 200 OK"),
    good.text.includes("\r\n\r\nok"),
    good.closed,
  );
  plain.close(() => console.log("closed"));
})();
