// A peer that upgrades and then goes away without a close frame is an
// unclean closure: Node emits 'error' before the 1006 'close', both for a
// plain FIN and for a reset, and whether the client had already called
// close() or not.
import * as http from "node:http";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

type Ending = "fin" | "reset";
type ClientClose = "none" | "close";

function trial(ending: Ending, clientClose: ClientClose): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer();
    let upgraded: Socket | null = null;
    server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
      socket.on("error", () => {});
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: " +
          acceptFor(String(req.headers["sec-websocket-key"])) +
          "\r\n\r\n"
      );
      upgraded = socket;
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const ws = new WebSocket("ws://127.0.0.1:" + String(port) + "/");
      const events: string[] = [];
      let label = ending + "/" + clientClose;
      ws.onopen = () => {
        events.push("open");
        if (clientClose === "close") ws.close();
      };
      ws.onerror = () => events.push("error");
      ws.onclose = (event: CloseEvent) => {
        events.push("close " + String(event.code) + " " + String(event.wasClean));
        console.log(label, events.join(" "), ws.readyState);
        server.close();
        resolve();
      };
      const wait = (): void => {
        if (upgraded === null) {
          setTimeout(wait, 1);
          return;
        }
        const socket = upgraded;
        setTimeout(() => {
          if (ending === "fin") socket.end();
          else socket.destroy();
        }, 20);
      };
      wait();
    });
  });
}

await trial("fin", "none");
await trial("fin", "close");
await trial("reset", "none");
await trial("reset", "close");
