import { createServer, request } from "node:http";
import { connect } from "node:net";

type Server = ReturnType<typeof createServer>;

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

function get(port: number, path: string, collect: (body: string) => void): void {
  const outbound = request({ host: "127.0.0.1", port, path }, (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    response.on("end", () => collect(body));
  });
  outbound.end();
}

function phaseWrites(next: () => void): void {
  const server = createServer((_req, res) => {
    res.sendDate = false;
    res.on("prefinish", () => console.log("prefinish"));
    res.on("finish", () => console.log("finish", res.writableFinished, res.writableEnded));
    res.on("close", () => console.log("close", res.writableFinished));
    console.log("start", res.headersSent, res.writableEnded, res.writableCorked, res.writableHighWaterMark > 0, res.writableObjectMode);
    res.write("a");
    res.write("b", () => console.log("write cb"));
    console.log("after writes", res.headersSent, res.writableLength > 0);
    res.end("c", () => console.log("end cb", res.writableFinished));
    console.log("after end", res.writableEnded, res.writableFinished);
  });
  server.listen(0, "127.0.0.1", () => {
    get(portOf(server), "/", (body) => {
      console.log("client body", body);
      server.close(next);
    });
  });
}

function phaseCork(next: () => void): void {
  const server = createServer((_req, res) => {
    res.sendDate = false;
    res.cork();
    res.cork();
    res.write("x");
    console.log("corked", res.writableCorked);
    res.uncork();
    console.log("uncorked", res.writableCorked, res.headersSent);
    res.uncork();
    res.end("y");
  });
  server.listen(0, "127.0.0.1", () => {
    get(portOf(server), "/", (body) => {
      console.log("cork body", body);
      server.close(next);
    });
  });
}

function phaseFlush(next: () => void): void {
  const server = createServer((_req, res) => {
    res.sendDate = false;
    res.setHeader("Content-Length", "2");
    res.flushHeaders();
    console.log("flushed", res.headersSent, res.writableEnded);
    res.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    get(portOf(server), "/", (body) => {
      console.log("flush body", body);
      server.close(next);
    });
  });
}

function phaseTrailers(next: () => void): void {
  const server = createServer((_req, res) => {
    res.sendDate = false;
    res.writeHead(200, { Trailer: "X-T" });
    res.write("ok");
    res.addTrailers({ "X-T": "v" });
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const socket = connect(portOf(server), "127.0.0.1");
    let wire = "";
    socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n"));
    socket.on("data", (chunk: Buffer) => {
      wire += chunk.toString("latin1");
    });
    socket.on("close", () => {
      console.log("trailer wire", JSON.stringify(wire.endsWith("0\r\nX-T: v\r\n\r\n")));
      server.close(next);
    });
  });
}

function phaseEncodings(next: () => void): void {
  const server = createServer((_req, res) => {
    res.sendDate = false;
    res.write("u", "utf8");
    res.write("v", "utf-8", () => console.log("encoding cb"));
    res.write("w", "utf8", undefined);
    res.end("x");
  });
  server.listen(0, "127.0.0.1", () => {
    get(portOf(server), "/", (body) => {
      console.log("encoding body", body);
      server.close(next);
    });
  });
}

function phaseStream(next: () => void): void {
  // A producer that writes each chunk from the previous write's callback:
  // every callback runs after its chunk was flushed, never on the writing
  // stack, and the chain yields to the loop between chunks.
  const chunk = "x".repeat(16 * 1024);
  const chunks = 64;
  const server = createServer((_req, res) => {
    res.sendDate = false;
    let remaining = chunks;
    let sync = true;
    const pump = (): void => {
      if (remaining === 0) {
        res.end();
        return;
      }
      remaining--;
      res.write(chunk, () => {
        console.log("write cb", sync ? "sync" : "async");
        pump();
      });
    };
    pump();
    sync = false;
  });
  server.listen(0, "127.0.0.1", () => {
    get(portOf(server), "/", (body) => {
      console.log("stream body", body.length);
      server.close(next);
    });
  });
}

phaseWrites(() =>
  phaseCork(() =>
    phaseFlush(() =>
      phaseTrailers(() =>
        phaseEncodings(() => phaseStream(() => console.log("done"))),
      ),
    ),
  ),
);
