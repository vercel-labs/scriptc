// tls.connect and tls.createServer with ALPNProtocols: the server answers
// with the first of its own protocols the client offers, both sockets
// report it as alpnProtocol, and a client that offers none of the
// server's fails with ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL. An
// array of strings, a Buffer or a Uint8Array in the wire format, an empty
// list and a falsy value all work as in Node, and invalid values throw
// Node's errors from tls.connect.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const ca = readFileSync(dir + "ca.pem");
const server = tls.createServer(
  {
    cert: readFileSync(dir + "localhost.pem"),
    key: readFileSync(dir + "localhost-key.pem"),
    ALPNProtocols: ["h2", "x/1"],
  },
  (socket) => {
    socket.end(`server:${String(socket.alpnProtocol)}`);
  },
);

function attempt(port: number, label: string, protocols: unknown): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = tls.connect({ host: "localhost", port, ca, ALPNProtocols: protocols as any }, () => {
      console.log(label, "client:", JSON.stringify(socket.alpnProtocol));
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => (data += chunk.toString()));
    socket.on("end", () => {
      console.log(label, data);
      resolve();
    });
    socket.on("error", (err) => {
      console.log(label, "error:", (err as NodeJS.ErrnoException).code);
      resolve();
    });
  });
}

function invalid(label: string, protocols: unknown): void {
  try {
    const socket = tls.connect({ host: "127.0.0.1", port: 1, ALPNProtocols: protocols as any });
    socket.on("error", () => {});
    socket.destroy();
    console.log(label, "accepted");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.name, err.code, err.message);
  }
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  await attempt(port, "strings", ["x/1", "h2"]);
  await attempt(port, "only-second", ["zz", "x/1"]);
  await attempt(port, "buffer", Buffer.from([2, 0x68, 0x32]));
  await attempt(port, "uint8array", new Uint8Array([3, 0x78, 0x2f, 0x31]));
  await attempt(port, "absent", undefined);
  await attempt(port, "empty", []);
  await attempt(port, "falsy", 0);
  await attempt(port, "no-match", ["zz"]);
  server.close();

  invalid("string", "h2");
  invalid("object", {});
  invalid("buffer-element", [Buffer.from("h2")]);
  invalid("number-element", [1]);
  invalid("empty-element", ["h2", ""]);
  invalid("too-long", ["a".repeat(256)]);
  invalid("zero-length", Buffer.from([0]));
  invalid("truncated", Buffer.from([5, 0x68]));
  invalid("long-zero", Buffer.alloc(60));
});
