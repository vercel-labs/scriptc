// headersTimeout and requestTimeout are enforced from the moment a
// connection is accepted: a client that sends no bytes, a partial request
// head, and an incomplete body each answer Node's 408 Request Timeout with
// Connection: close and no Date line, then the socket is destroyed. A
// 'clientError' listener receives ERR_HTTP_REQUEST_TIMEOUT instead and owns
// the socket.
import { createServer } from "node:http";
import { connect } from "node:net";

type Socket = ReturnType<typeof connect>;
type Server = ReturnType<typeof createServer>;

function exercise(label: string, server: Server, send: (socket: Socket) => void, done: () => void): void {
  server.listen(0, () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const socket = connect(port, "127.0.0.1");
    let wire = "";
    socket.on("connect", () => send(socket));
    socket.on("data", (chunk: Buffer) => {
      wire += chunk.toString("latin1");
    });
    socket.on("close", () => {
      console.log(label, JSON.stringify(wire));
      server.close(done);
    });
  });
}

const silentServer = createServer({ connectionsCheckingInterval: 25 });
silentServer.headersTimeout = 100;
silentServer.requestTimeout = 5000;
exercise(
  "silent",
  silentServer,
  () => {},
  () => {
    const headersServer = createServer({ connectionsCheckingInterval: 25 });
    headersServer.headersTimeout = 100;
    headersServer.requestTimeout = 5000;
    exercise(
      "headers",
      headersServer,
      (socket) => socket.write("GET / HTTP/1.1\r\nHost: local"),
      () => {
        const requestServer = createServer({ connectionsCheckingInterval: 25 });
        requestServer.headersTimeout = 100;
        requestServer.requestTimeout = 200;
        exercise(
          "request",
          requestServer,
          (socket) =>
            socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nab"),
          () => {
            const listened = createServer({ connectionsCheckingInterval: 25 });
            listened.headersTimeout = 100;
            listened.requestTimeout = 5000;
            listened.on("clientError", (error: NodeJS.ErrnoException, socket) => {
              console.log("clientError", error.code, error.message);
              socket.destroy();
            });
            exercise(
              "listened",
              listened,
              (socket) => socket.write("GET / HTTP/1.1\r\nHost: local"),
              () => console.log("done"),
            );
          },
        );
      },
    );
  },
);
