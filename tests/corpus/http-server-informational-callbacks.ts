// Informational responses: writeContinue/writeProcessing/writeEarlyHints
// invoke their callbacks once written, and writeContinue() marks the
// response as having answered Expect: 100-continue so a checkContinue
// handler's final response keeps the connection alive (without it Node
// closes the connection).
import { createServer } from "node:http";
import { connect } from "node:net";

type Server = ReturnType<typeof createServer>;

function readSocket(port: number, request: string, label: string, done: () => void): void {
  const socket = connect(port, "127.0.0.1");
  let wire = "";
  socket.on("connect", () => socket.write(request));
  socket.on("data", (chunk: Buffer) => {
    wire += chunk.toString("latin1");
  });
  socket.on("close", () => {
    const heads = wire.split("\r\n\r\n");
    for (let index = 0; index < heads.length - 1; index++) {
      console.log(label, "head", JSON.stringify(heads[index]!.split("\r\n")));
    }
    console.log(label, "body", JSON.stringify(heads[heads.length - 1]));
    done();
  });
  setTimeout(() => socket.destroy(), 150);
}

const server = createServer((req, res) => {
  res.sendDate = false;
  res.writeContinue(() => console.log("continue cb"));
  res.writeProcessing(() => console.log("processing cb"));
  res.writeEarlyHints({ link: "</a.css>; rel=preload" }, () => console.log("hints cb"));
  res.end("done");
});

const lateServer = createServer((_req, res) => {
  res.sendDate = false;
  res.writeHead(200, { "Content-Length": "2" });
  let callbackRan = false;
  try {
    res.writeContinue(() => {
      callbackRan = true;
    });
    console.log("late accepted");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log("late error", e.code);
  }
  console.log("late callback", callbackRan);
  res.end("ok");
});

function expectScenario(withContinue: boolean, next: () => void): void {
  const label = withContinue ? "with" : "without";
  const listener = createServer();
  listener.on("checkContinue", (req, res) => {
    res.sendDate = false;
    if (withContinue) res.writeContinue(() => console.log(`${label} continue cb`));
    req.resume();
    req.on("end", () => res.end("body"));
  });
  listener.listen(0, () => {
    const address = listener.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    readSocket(
      port,
      "POST / HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 4\r\n\r\nbody",
      label,
      () => listener.close(next),
    );
  });
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  readSocket(
    port,
    "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    "callbacks",
    () =>
      server.close(() =>
        lateServer.listen(0, "127.0.0.1", () => {
          const lateAddress = lateServer.address();
          const latePort = typeof lateAddress === "object" && lateAddress !== null ? lateAddress.port : 0;
          readSocket(latePort, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n", "late", () =>
            lateServer.close(() =>
              expectScenario(true, () => expectScenario(false, () => console.log("done"))),
            ),
          );
        }),
      ),
  );
});
