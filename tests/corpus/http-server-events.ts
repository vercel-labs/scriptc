// The server-side event surface: a request handler installed after
// createServer() receives requests through 'request', 'connection' fires
// once per raw socket before any request, 'checkContinue' replaces the
// automatic 100-continue reply, 'checkExpectation' handles an Expect value
// that is not 100-continue, and 'close' reports the server shutting down.
import * as http from "node:http";

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

const closed = (server: http.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const origin = "127.0.0.1";

void (async () => {
  // Handler added after construction: 'request' still delivers it.
  const deferred = http.createServer();
  deferred.on("request", (req, res) => {
    console.log("deferred request", req.method, req.url);
    res.end("deferred");
  });
  deferred.on("connection", (socket) => {
    console.log("deferred connection", typeof socket.remotePort, socket.destroyed, socket.readable);
  });
  const deferredPort = await listen(deferred);
  await new Promise<void>((resolve) => {
    http.get({ host: origin, port: deferredPort, agent: false }, (res) => {
      res.resume();
      res.on("end", () => {
        console.log("deferred status", res.statusCode);
        deferred.close(() => {
          console.log("deferred closed");
          resolve();
        });
      });
    });
  });

  // checkContinue takes over the interim reply and replaces 'request'.
  const continued = http.createServer((_req, res) => {
    console.log("continued request handler");
    res.end("unexpected");
  });
  continued.on("checkContinue", (req, res) => {
    const chunks: Buffer[] = [];
    console.log("checkContinue", req.method, req.headers.expect, req.headers["content-length"]);
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      console.log("continued request body", Buffer.concat(chunks).toString());
      res.end("continued");
    });
    res.writeContinue();
  });
  const continuedPort = await listen(continued);
  await new Promise<void>((resolve) => {
    const req = http.request(
      {
        host: origin,
        port: continuedPort,
        method: "POST",
        path: "/continue",
        headers: { expect: "100-continue", "content-length": "4" },
        agent: false,
      },
      (res) => {
        console.log("continued status", res.statusCode);
        res.resume();
        res.on("end", () => {
          continued.close(() => resolve());
        });
      },
    );
    req.on("continue", () => console.log("client continue"));
    req.end("body");
  });

  // checkExpectation handles any other Expect value.
  const expected = http.createServer((_req, res) => {
    console.log("expected request");
    res.end("plain");
  });
  expected.on("checkExpectation", (req, res) => {
    console.log("checkExpectation", req.headers.expect);
    res.statusCode = 417;
    res.end("expected");
  });
  const expectedPort = await listen(expected);
  await new Promise<void>((resolve) => {
    http
      .request(
        {
          host: origin,
          port: expectedPort,
          method: "POST",
          headers: { expect: "something-else", "content-length": "0" },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            console.log("expected status", res.statusCode, Buffer.concat(chunks).toString());
            expected.close(() => resolve());
          });
        },
      )
      .end();
  });

  // A checkContinue listener can refuse the body with an ordinary response
  // instead of calling writeContinue; 'request' still does not fire.
  const declined = http.createServer((_req, res) => {
    console.log("declined request");
    res.end("unexpected");
  });
  declined.on("checkContinue", (req, res) => {
    console.log("declined checkContinue", req.headers.expect);
    res.statusCode = 400;
    res.end("no body");
  });
  const declinedPort = await listen(declined);
  await new Promise<void>((resolve) => {
    const req = http.request(
      {
        host: origin,
        port: declinedPort,
        method: "POST",
        headers: { expect: "100-continue", "content-length": "4" },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          console.log("declined status", res.statusCode, Buffer.concat(chunks).toString());
          declined.close(() => resolve());
        });
      },
    );
    req.on("continue", () => console.log("declined continue"));
    req.on("error", () => {});
    req.end("body");
  });

  // Without a checkContinue listener the server answers 100 Continue
  // itself and still emits 'request'.
  const automatic = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      console.log("automatic request body", Buffer.concat(chunks).toString());
      res.end("automatic");
    });
  });
  const automaticPort = await listen(automatic);
  await new Promise<void>((resolve) => {
    const req = http.request(
      {
        host: origin,
        port: automaticPort,
        method: "POST",
        path: "/automatic",
        headers: { expect: "100-continue", "content-length": "4" },
        agent: false,
      },
      (res) => {
        console.log("automatic status", res.statusCode);
        res.resume();
        res.on("end", () => {
          automatic.close(() => resolve());
        });
      },
    );
    req.on("continue", () => console.log("automatic continue"));
    req.end("body");
  });

  // Without a checkExpectation listener the server answers 417 and does
  // not emit 'request'.
  const rejected = http.createServer((_req, res) => {
    console.log("rejected request");
    res.end("unexpected");
  });
  const rejectedPort = await listen(rejected);
  await new Promise<void>((resolve) => {
    http
      .request(
        {
          host: origin,
          port: rejectedPort,
          method: "POST",
          headers: { expect: "something-else", "content-length": "0" },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            console.log("rejected status", res.statusCode, Buffer.concat(chunks).toString());
            rejected.close(() => resolve());
          });
        },
      )
      .end();
  });

  // 'close' fires after the last connection drained.
  const closing = http.createServer((_req, res) => res.end("ok"));
  const closingPort = await listen(closing);
  closing.on("close", () => console.log("closing event"));
  await new Promise<void>((resolve) => {
    http.get({ host: origin, port: closingPort, agent: false }, (res) => {
      res.resume();
      res.on("end", () => {
        closing.close(() => resolve());
      });
    });
  });

  const finishing = http.createServer((_req, res) => res.end("ok"));
  await listen(finishing);
  await closed(finishing);
  console.log("done");
})();
