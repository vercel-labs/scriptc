// IncomingMessage.off/removeListener and ServerResponse.off/removeListener:
// a listener removed before its event arrives never runs, removeListener is
// off's alias, removing a function that is not registered changes nothing,
// and the listeners that remain still fire in registration order. Strict
// ping-pong: one exchange in flight at a time, every line causally ordered.
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const dropped = (chunk: Buffer): void => {
    console.log("req dropped data listener ran", chunk.length);
  };
  const droppedEnd = (): void => {
    console.log("req dropped end listener ran");
  };
  req.on("data", dropped);
  req.off("data", dropped);
  req.once("end", droppedEnd);
  req.removeListener("end", droppedEnd);
  // Removing a function that was never registered leaves every list alone.
  req.removeListener("data", dropped);
  req.off("error", droppedEnd);

  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => {
    console.log(`req body: ${body}`);
    const onFinish = (): void => {
      console.log("res dropped finish listener ran");
    };
    res.on("finish", onFinish);
    res.off("finish", onFinish);
    const onClose = (): void => {
      console.log("res dropped close listener ran");
    };
    res.on("close", onClose);
    res.removeListener("close", onClose);
    res.on("close", () => console.log("res close survivor"));
    res.end("ok");
  });
});

const onListening = (): void => {
  const port = server.address().port;
  const req = request(
    { port, path: "/upper", method: "POST", headers: { "content-type": "text/plain" } },
    (res: IncomingMessage) => {
      const dropped = (chunk: Buffer): void => {
        console.log("client dropped data listener ran", chunk.length);
      };
      res.on("data", dropped);
      res.off("data", dropped);
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      res.on("end", () => {
        console.log(`client body: ${body}`);
        server.close(() => console.log("server closed"));
      });
    }
  );
  req.end("payload");
};

server.listen(0, onListening);
