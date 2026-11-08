// Interim (1xx) responses on the HTTP/1 client. A request whose options
// carry an Expect header sends its head when it is constructed, so the
// server can answer 100 Continue before a body exists: 'continue' against
// a 'checkContinue' server, the default server and a raw socket peer, with
// the head each request puts on the wire. 'information' reports every 1xx
// response but 101, with response.writeProcessing() and writeEarlyHints()
// as the peer, the event object whole, several interim responses in one
// segment, once(), a listener without parameters, and a request that went
// through a function parameter. Once a response's head is committed, the
// server's interim writers throw. The typed twin of
// compat-http-interim-responses.mjs.
import * as http from "node:http";
import * as net from "node:net";

// A raw peer: prints the request head it receives (the port in Host
// replaced) and calls onHead(socket); once the body is complete by the
// head's framing it prints the body bytes and calls onBody(socket).
function rawServer(tag: string, onHead: (socket: net.Socket) => void, onBody: (socket: net.Socket) => void): net.Server {
  return net.createServer((socket) => {
    let text = "";
    let head = "";
    let state = 0;
    socket.on("data", (chunk) => {
      text += chunk;
      if (state === 0) {
        const end = text.indexOf("\r\n\r\n");
        if (end < 0) return;
        head = text.slice(0, end);
        text = text.slice(end + 4);
        state = 1;
        console.log(tag, "head", JSON.stringify(head.replace(/Host: 127\.0\.0\.1:\d+/, "Host: H")));
        onHead(socket);
      }
      if (state !== 1) return;
      const length = /Content-Length: (\d+)/.exec(head);
      const complete = length
        ? text.length >= Number(length[1])
        : head.includes("Transfer-Encoding: chunked")
          ? text.endsWith("0\r\n\r\n")
          : true;
      if (complete) {
        state = 2;
        console.log(tag, "body", JSON.stringify(text));
        onBody(socket);
      }
    });
  });
}

// 1. 'checkContinue' on the server, 'continue' on the client. The head is
// out before the body: setHeader() and removeHeader() afterwards throw.
await new Promise<void>((resolve) => {
  const server = http.createServer((_request, response) => response.end("plain"));
  server.on("checkContinue", (request, response) => {
    console.log("1 checkContinue", request.method, request.headers.expect);
    response.writeContinue();
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
    });
    request.on("end", () => response.end("got " + received));
  });
  server.listen(0, "127.0.0.1", () => {
    const request = http.request(
      { port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", method: "POST", headers: { Expect: "100-continue" }, agent: false },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          console.log("1 response", response.statusCode, body);
          server.close(() => resolve());
        });
      },
    );
    console.log("1 headersSent", request.headersSent);
    try {
      request.setHeader("x-late", "1");
    } catch (error) {
      console.log("1 setHeader", (error as NodeJS.ErrnoException).code);
    }
    try {
      request.removeHeader("expect");
    } catch (error) {
      console.log("1 removeHeader", (error as NodeJS.ErrnoException).code, (error as Error).message);
    }
    request.on("continue", () => {
      console.log("1 continue");
      request.end("body");
    });
  });
});

// 2. Without a 'checkContinue' listener the server answers 100 Continue
// itself and delivers the request.
await new Promise<void>((resolve) => {
  const server = http.createServer((request, response) => {
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
    });
    request.on("end", () => response.end(request.method + " " + received));
  });
  server.listen(0, "127.0.0.1", () => {
    const request = http.request(
      { port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", method: "PUT", headers: { Expect: "100-continue" }, agent: false },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          console.log("2 response", response.statusCode, body);
          server.close(() => resolve());
        });
      },
    );
    request.once("continue", () => {
      console.log("2 continue");
      request.write("12");
      request.end("345");
    });
  });
});

// 3. The head on the wire, from a raw peer that answers 100 Continue and
// then 200: a POST with Content-Length, a POST without one (chunked) and a
// GET (no framing header) through an agent without keep-alive, then a POST
// through a keep-alive agent and one through the global agent; the agent
// decides the Connection header.
function wire(
  tag: string,
  body: string,
  open: (port: number, onResponse: (response: http.IncomingMessage) => void) => http.ClientRequest,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const server = rawServer(
      tag,
      (socket) => socket.write("HTTP/1.1 100 Continue\r\n\r\n"),
      (socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    );
    server.listen(0, "127.0.0.1", () => {
      const request = open((server.address() as net.AddressInfo).port, (response) => {
        console.log(tag, "response", response.statusCode);
        response.resume();
        response.on("end", () => server.close(() => resolve()));
      });
      request.on("continue", () => {
        console.log(tag, "continue");
        request.end(body);
      });
    });
  });
}
const closing = new http.Agent();
const keeping = new http.Agent({ keepAlive: true });
await wire("3a", "body", (port, onResponse) =>
  http.request({ port, host: "127.0.0.1", method: "POST", headers: { Expect: "100-continue", "Content-Length": "4" }, agent: closing }, onResponse),
);
await wire("3b", "body", (port, onResponse) =>
  http.request({ port, host: "127.0.0.1", method: "POST", headers: { expect: "100-Continue" }, agent: closing }, onResponse),
);
await wire("3c", "", (port, onResponse) =>
  http.request({ port, host: "127.0.0.1", method: "GET", headers: { Expect: "100-continue" }, agent: closing }, onResponse),
);
await wire("3d", "x", (port, onResponse) =>
  http.request({ port, host: "127.0.0.1", method: "POST", headers: { Expect: "100-continue" }, agent: keeping }, onResponse),
);
await wire("3e", "x", (port, onResponse) =>
  http.request({ port, host: "127.0.0.1", method: "PUT", headers: { Expect: "100-continue" } }, onResponse),
);

// 4. 'information' for 102 and 103, before 'response'; the event object.
await new Promise<void>((resolve) => {
  const server = http.createServer((_request, response) => {
    response.writeProcessing();
    response.writeEarlyHints({ link: "</a.css>; rel=preload; as=style", "x-trace": "t1" });
    response.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const request = http.get({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", agent: false }, (response) => {
      console.log("4 response", response.statusCode);
      response.resume();
      response.on("end", () => server.close(() => resolve()));
    });
    request.on("information", (info) => {
      console.log("4 information", info.statusCode, info.statusMessage, info.httpVersion, info.httpVersionMajor, info.httpVersionMinor);
      console.log("4 headers", info.headers.link, info.headers["x-trace"], info.rawHeaders);
      console.log("4 object", JSON.stringify(info), Object.keys(info).join(","));
    });
  });
});

// 5. Several interim responses in one segment from a raw peer: 'continue'
// comes before the 'information' of the same 100; once() and a listener
// without parameters; a repeated header.
await new Promise<void>((resolve) => {
  const server = rawServer(
    "5",
    (socket) =>
      socket.write(
        "HTTP/1.1 102 Processing\r\n\r\n" +
          "HTTP/1.1 103 Early Hints\r\nLink: </a>; rel=preload\r\nX-Dup: 1\r\nX-Dup: 2\r\n\r\n" +
          "HTTP/1.1 100 Continue\r\n\r\n" +
          "HTTP/1.1 199 Custom Thing\r\n\r\n" +
          "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
      ),
    (socket) => socket.end(),
  );
  server.listen(0, "127.0.0.1", () => {
    const request = http.get({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", agent: closing }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        closing.destroy();
        keeping.destroy();
        console.log("5 response", response.statusCode, body);
        server.close(() => resolve());
      });
    });
    let count = 0;
    request.on("continue", () => console.log("5 continue"));
    request.once("information", (info) => console.log("5 once", info.statusCode));
    request.on("information", () => {
      count++;
    });
    request.addListener("information", (info) => {
      console.log("5 information", info.statusCode, JSON.stringify(info.statusMessage), info.httpVersion, JSON.stringify(info.headers), count);
    });
  });
});

// 6. A request that went through a function parameter registers the same
// listeners.
function watch(request: http.ClientRequest, tag: string): void {
  request.on("continue", () => {
    console.log(tag, "continue");
    request.end("late");
  });
  request.on("information", (info) => console.log(tag, "information", info.statusCode, typeof info.headers, info.rawHeaders.length));
}
await new Promise<void>((resolve) => {
  const server = http.createServer((request, response) => {
    let received = "";
    request.on("data", (chunk) => {
      received += chunk;
    });
    request.on("end", () => {
      response.writeProcessing();
      response.end(received);
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const request = http.request(
      { port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", method: "POST", headers: { Expect: "100-continue" }, agent: false },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          console.log("6 response", response.statusCode, body);
          server.close(() => resolve());
        });
      },
    );
    watch(request, "6");
  });
});

// 7. After writeHead() the interim writers throw ERR_HTTP_HEADERS_SENT and
// nothing interim reaches the client.
function attempt(tag: string, write: () => void): void {
  try {
    write();
    console.log(tag, "no throw");
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log(tag, caught.code, caught.message);
  }
}
await new Promise<void>((resolve) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    attempt("7 writeContinue", () => response.writeContinue());
    attempt("7 writeProcessing", () => response.writeProcessing());
    attempt("7 writeEarlyHints", () => response.writeEarlyHints({ link: "</a.css>; rel=preload" }));
    response.end("late");
  });
  server.listen(0, "127.0.0.1", () => {
    let interim = 0;
    const request = http.get({ port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", agent: false }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        console.log("7 response", response.statusCode, body, interim);
        server.close(() => resolve());
      });
    });
    request.on("information", () => {
      interim++;
    });
  });
});
