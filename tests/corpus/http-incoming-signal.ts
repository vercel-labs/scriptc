// IncomingMessage.signal: one AbortSignal for every read, aborted when the
// message is destroyed or the connection closes before it completed — after
// 'aborted', as in Node — and left alone by a complete exchange.
import * as http from "node:http";
import * as net from "node:net";

const reason = (signal: AbortSignal): string => {
  const r = signal.reason as { name?: string; code?: string | number } | undefined;
  return r === undefined ? "none" : `${r.name}/${r.code}`;
};

// Reading through an untyped value: the runtime's member dispatch answers the
// same signal, which the program's feature scan has to account for.
const readSignal = (message: any): AbortSignal => message.signal as AbortSignal;

const server = http.createServer((req, res) => {
  if (req.url === "/normal") {
    console.log("server any-read", readSignal(req) === req.signal);
    console.log("server normal", req.signal.aborted, req.signal === req.signal);
    req.signal.addEventListener("abort", () => console.log("server aborted", reason(req.signal)));
    req.on("data", () => {});
    req.on("end", () => {
      console.log("server end", req.signal.aborted);
      res.end("ok");
    });
    return;
  }
  if (req.url === "/premature") {
    // the client goes away while the response is still streaming
    console.log("server premature", req.signal.aborted);
    req.signal.addEventListener("abort", () => console.log("server premature aborted", reason(req.signal)));
    req.on("data", () => {});
    req.on("end", () => res.end("ok"));
    return;
  }
  res.end("ok");
});

// A peer that sends one chunk and never ends the body: the client's own
// destroy() is the only ending, so the case has no race.
const holding = net.createServer((socket) => {
  socket.once("data", () => {
    socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n");
  });
});

const raw = net.createServer((socket) => {
  socket.once("data", () => {
    socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n");
    setTimeout(() => socket.destroy(), 10);
  });
});

server.listen(0, "127.0.0.1", () => {
  holding.listen(0, "127.0.0.1", () => {
  raw.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    // 1. a complete exchange: the signal never aborts
    http.get({ host: "127.0.0.1", port, path: "/normal" }, (res) => {
      console.log("client normal", res.signal.aborted, res.signal === res.signal);
      res.signal.addEventListener("abort", () => console.log("client normal aborted", reason(res.signal)));
      res.resume();
      res.on("end", () => {
        console.log("client end", res.signal.aborted);
        // 2. the server's request is aborted when the client destroys mid-body
        const post = http.request({
          host: "127.0.0.1",
          port,
          path: "/premature",
          method: "POST",
          headers: { "transfer-encoding": "chunked" },
        });
        post.on("error", () => {});
        post.write("abc");
        setTimeout(() => post.destroy(), 10);
        // 2b. destroying an unfinished message aborts its signal inside
        // destroy(): 'aborted' first, then the abort listeners.
        setTimeout(() => {
          http.get({ host: "127.0.0.1", port: (holding.address() as { port: number }).port, path: "/" }, (res) => {
            console.log("destroy read", res.signal.aborted);
            res.signal.addEventListener("abort", () => console.log("destroy listener", res.signal.aborted));
            res.on("aborted", () => console.log("destroy aborted event", res.signal.aborted));
            res.on("data", () => {
              res.destroy();
              console.log("after destroy", res.signal.aborted);
            });
            res.on("error", () => {});
            res.on("close", () => console.log("destroy close", res.signal.aborted));
          }).on("error", () => {});
        }, 40);
        // 3. a response whose connection dies before the body completes
        setTimeout(() => {
          http.get({ host: "127.0.0.1", port: (raw.address() as { port: number }).port, path: "/" }, (res) => {
            console.log("client raw", res.signal.aborted);
            res.on("aborted", () => console.log("client raw aborted event"));
            res.signal.addEventListener("abort", () => console.log("client raw signal", reason(res.signal)));
            res.on("error", () => {});
            res.on("data", () => {});
            res.on("close", () => {
              console.log("client raw close", res.signal.aborted);
              raw.close();
              holding.close();
              server.close();
            });
          }).on("error", () => {});
        }, 80);
      });
    });
  });
  });
});
