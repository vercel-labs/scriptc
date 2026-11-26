// The options literal is evaluated before the session exists: a throwing
// authorization helper aborts the handshake (the connection listener's catch
// runs) instead of being erased — the security-relevant shape.
import * as http2 from "node:http2";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
function authorize() {
  throw new Error("peer rejected");
}

const server = createServer((socket) => {
  try {
    const session = http2.performServerHandshake(socket, { settings: authorize() });
    lines.push(`created ${session.type}`);
  } catch (error) {
    lines.push(`rejected ${(error as Error).message}`);
    socket.destroy();
    server.close(() => {
      for (const line of lines) console.log(line);
    });
  }
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on("error", () => {});
  const request = client.request({ ":path": "/" });
  request.on("error", () => {});
  request.resume();
  request.end();
});
