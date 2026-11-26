// http2.performServerHandshake on a socket the program paused: Node resumes
// the socket, so the preface is read and the request is answered. The
// session's 'stream' listener responds on the same paused socket.
import * as http2 from "node:http2";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
let sessionClosed = false;
let serverClosed = false;

function maybeDone(): void {
  if (!sessionClosed || !serverClosed) return;
  for (const line of lines) console.log(line);
}

const server = createServer((socket) => {
  socket.pause();
  lines.push("paused");
  const session = http2.performServerHandshake(socket);
  lines.push(`session type ${session.type}`);
  session.on("stream", (stream, headers) => {
    lines.push(`stream ${String(headers[":path"])}`);
    stream.respond({ ":status": 200 });
    stream.end("paused ok");
  });
  session.on("close", () => {
    lines.push("session close");
    sessionClosed = true;
    maybeDone();
  });
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const request = client.request({ ":path": "/paused" });
  request.on("response", (headers) => lines.push(`response ${headers[":status"]}`));
  request.on("data", (chunk) => lines.push(`data ${String(chunk)}`));
  request.on("end", () => {
    client.close(() => {
      server.close(() => {
        lines.push("server closed");
        serverClosed = true;
        maybeDone();
      });
    });
  });
  request.resume();
  request.end();
});
