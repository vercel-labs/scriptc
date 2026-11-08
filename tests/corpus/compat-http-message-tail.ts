// Members of http's outgoing and incoming messages the other programs do
// not reach: 'prefinish' on a ServerResponse (inside end(), before
// 'finish'), writableHighWaterMark and writableObjectMode, a request made
// with `agent: false` (the head on the wire, what the request reports
// about its own headers, a headers record that is not a literal),
// http.setMaxIdleHTTPParsers() with its argument errors, and a server's
// 'clientError' for a request the parser rejects. The typed twin
// of compat-http-message-tail.mjs.
import * as http from "node:http";
import * as net from "node:net";

// 1. 'prefinish' fires inside end(), 'finish' afterwards; once() and on().
await new Promise<void>((resolve) => {
  const server = http.createServer((_request, response) => {
    response.on("prefinish", () => console.log("1 prefinish", response.writableEnded, response.headersSent));
    response.once("prefinish", () => console.log("1 prefinish once"));
    response.on("finish", () => console.log("1 finish"));
    console.log("1 state", response.writableHighWaterMark, response.writableObjectMode);
    response.write("a");
    console.log("1 before end");
    response.end("b");
    console.log("1 after end");
    response.on("prefinish", () => console.log("1 prefinish (never)"));
  });
  server.listen(0, "127.0.0.1", () => {
    http.get({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", agent: false }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        console.log("1 body", body);
        server.close(() => resolve());
      });
    });
  });
});

// 2. The same members on a response that went through a function.
function inspect(response: http.ServerResponse, tag: string): void {
  console.log(tag, response.writableHighWaterMark, response.writableObjectMode);
  response.on("prefinish", () => console.log(tag, "prefinish"));
}
await new Promise<void>((resolve) => {
  const server = http.createServer((_request, response) => {
    inspect(response, "2");
    response.end();
    console.log("2 after end");
  });
  server.listen(0, "127.0.0.1", () => {
    http.get({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", agent: false }, (response) => {
      response.resume();
      response.on("end", () => server.close(() => resolve()));
    });
  });
});

// 3. agent: false. A raw peer prints the heads: Connection: close follows
// Host; the request does not list it among its own headers; a header the
// caller sets wins; the headers option may be a record; a POST body gets a
// Content-Length and a DELETE body, like a GET's, no framing header.
await new Promise<void>((resolve) => {
  let served = 0;
  const server = net.createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (!text.includes("\r\n\r\n")) return;
      console.log("3 head", JSON.stringify(text.replace(/Host: 127\.0\.0\.1:\d+/, "Host: H")));
      text = "";
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      if (++served === 5) server.close(() => resolve());
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as net.AddressInfo).port;
    const plain = http.get({ port, host: "127.0.0.1", agent: false }, (response) => {
      response.resume();
      response.on("end", () => {
        const own = http.get({ port, host: "127.0.0.1", agent: false, headers: { Connection: "keep-alive", "X-A": "1" } }, (second) => {
          second.resume();
          second.on("end", () => {
            const record: Record<string, string> = { accept: "*/*", "x-from": "record" };
            http.get({ port, host: "127.0.0.1", agent: false, headers: record }, (third) => {
              third.resume();
              third.on("end", () => {
                const post = http.request({ port, host: "127.0.0.1", method: "POST", agent: false }, (fourth) => {
                  fourth.resume();
                  fourth.on("end", () => {
                    const remove = http.request({ port, host: "127.0.0.1", method: "DELETE", agent: false }, (fifth) => {
                      fifth.resume();
                    });
                    remove.end("gone");
                  });
                });
                post.end("body");
              });
            });
          });
        });
        console.log("3 own", own.getHeader("connection"), JSON.stringify(own.getRawHeaderNames()));
      });
    });
    console.log("3 plain", plain.getHeader("connection"), plain.hasHeader("connection"), JSON.stringify(plain.getRawHeaderNames()));
  });
});

// 4. http.setMaxIdleHTTPParsers validates its argument like Node.
http.setMaxIdleHTTPParsers(8);
const rejected: any[] = ["x", 0, 1.5, -1, undefined, null, 2 ** 53];
for (const bad of rejected) {
  try {
    http.setMaxIdleHTTPParsers(bad);
    console.log("4 accepted", bad);
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log("4", caught.name, caught.code, caught.message);
  }
}

// 5. 'clientError': a request the parser rejects goes to the listener,
// which answers on the socket.
await new Promise<void>((resolve) => {
  const server = http.createServer((_request, response) => response.end());
  server.on("clientError", (error: NodeJS.ErrnoException, socket: net.Socket) => {
    console.log("5 clientError", error.code);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => client.write("garbage\r\n\r\n"));
    let reply = "";
    client.on("data", (chunk) => {
      reply += chunk.toString();
    });
    client.on("close", () => {
      console.log("5 reply", reply.split("\r\n")[0]);
      server.close(() => resolve());
    });
  });
});
