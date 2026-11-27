// A request's write/end callbacks: write(chunk, cb) runs once the chunk has
// reached the socket — never while it is still in the message's cork buffer —
// and end(...) callbacks run when the request's body has gone out, with data,
// with null/undefined data, or with none.
import * as http from "node:http";
import * as net from "node:net";

const peer = net.createServer((socket) => {
  let data = "";
  let answered = false;
  const respond = (): void => {
    if (answered) return;
    answered = true;
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  };
  const check = (): void => {
    const split = data.indexOf("\r\n\r\n");
    if (split < 0) return;
    const head = data.slice(0, split);
    const body = data.slice(split + 4);
    const match = /content-length: *(\d+)/i.exec(head);
    if (match !== null) {
      if (body.length >= Number(match[1])) respond();
      return;
    }
    if (head.toLowerCase().includes("transfer-encoding: chunked")) {
      if (body.includes("\r\n0\r\n\r\n") || body.endsWith("0\r\n\r\n")) respond();
      return;
    }
    respond();
  };
  socket.on("data", (chunk: Buffer) => {
    data += chunk.toString("latin1");
    check();
  });
  socket.on("end", () => {});
  socket.on("error", () => {});
});

const cases: Array<[string, (port: number, done: () => void) => void]> = [
  [
    "end-data-cb",
    (port, done) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", done);
      });
      req.end("x", () => console.log("end-data-cb callback"));
    },
  ],
  [
    "end-undefined-cb",
    (port, done) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", done);
      });
      req.end(undefined, "utf8", () => console.log("end-undefined-cb callback"));
    },
  ],
  [
    "end-null-cb",
    (port, done) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", done);
      });
      req.end(null, () => console.log("end-null-cb callback"));
    },
  ],
  [
    "end-cb",
    (port, done) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", done);
      });
      req.end(() => console.log("end-cb callback"));
    },
  ],
  [
    "plain-write-cb",
    (port, done) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", done);
      });
      req.write("cd", () => console.log("plain write callback"));
      req.end();
    },
  ],
  [
    "corked-write-cb",
    (port, done) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
        res.resume();
        res.on("end", done);
      });
      req.cork();
      req.write("ab", () => console.log("corked write callback"));
      setImmediate(() => {
        console.log("still corked: callback has not run");
        req.uncork();
        setImmediate(() => req.end());
      });
    },
  ],
];

peer.listen(0, "127.0.0.1", () => {
  const port = (peer.address() as { port: number }).port;
  const next = (i: number): void => {
    if (i >= cases.length) {
      peer.close();
      return;
    }
    const entry = cases[i]!;
    console.log(entry[0], "start");
    entry[1](port, () => {
      console.log(entry[0], "done");
      next(i + 1);
    });
  };
  next(0);
});
