// The chunk and encoding checks write_ makes before it buffers anything:
// null is ERR_STREAM_NULL_VALUES, a number/object/array is
// ERR_INVALID_ARG_TYPE naming the chunk argument, and an unknown encoding on
// a string chunk is ERR_UNKNOWN_ENCODING (a Buffer chunk ignores it). A write
// after end() answers false, then reports ERR_STREAM_WRITE_AFTER_END to the
// write's callback and the response's 'error' listeners; end(chunk) after
// end() reports it the same way, while end() alone is a no-op; a write after
// the exchange completed finds the request destroyed, so only its callback
// hears about it.
import http from "node:http";

function withServer(handler, drive) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      drive(port, () => server.close(resolve));
    });
  });
}

function fetchBody(port, path) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.end();
  });
}

// 1. The chunk types and the encoding argument, each refused or accepted
// before anything enters the message.
await withServer(
  (req, res) => {
    const tries = [
      ["null", () => res.write(null)],
      ["undefined", () => res.write(undefined)],
      ["number", () => res.write(5)],
      ["object", () => res.write({ a: 1 })],
      ["array", () => res.write(["a"])],
      ["unknown encoding", () => res.write("x", "nope")],
      ["number encoding", () => res.write("x", 5)],
      ["empty string", () => res.write("")],
      ["empty buffer", () => res.write(Buffer.alloc(0))],
    ];
    for (const [name, run] of tries) {
      try {
        console.log("write", name, run());
      } catch (err) {
        console.log("write", name, "throws", err.code, err.message);
      }
    }
    res.end();
  },
  async (port, done) => {
    console.log("1 body", JSON.stringify(await fetchBody(port, "/")));
    done();
  },
);

// 2. write() after end(): false now, then the callback and the 'error'
// listener one tick later.
await withServer(
  (req, res) => {
    res.on("error", (err) => console.log("2 error", err.code, err.message));
    res.end("a");
    const answered = res.write("b", () => console.log("2 write callback"));
    console.log("2 write after end", answered);
  },
  async (port, done) => {
    console.log("2 body", JSON.stringify(await fetchBody(port, "/")));
    done();
  },
);

// 3. end(chunk) after end() reports WRITE_AFTER_END; end() with no chunk is
// a quiet no-op, and an empty string is no chunk at all.
await withServer(
  (req, res) => {
    res.on("error", (err) => console.log("3 error", err.code, err.message));
    res.end("x");
    const answered = res.end();
    console.log("3 end after end", answered === res, res.writableEnded);
    res.end("");
    console.log("3 end empty string", res.writableEnded);
    res.end("y", () => console.log("3 end chunk callback"));
    console.log("3 end chunk after end", res.writableEnded);
  },
  async (port, done) => {
    console.log("3 body", JSON.stringify(await fetchBody(port, "/")));
    done();
  },
);

// 4. A written request body through to the response, then a write on the
// destroyed request: the callback runs, no 'error' is emitted.
await withServer(
  (req, res) => {
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
    });
    req.on("end", () => res.end("read " + bytes));
  },
  (port, done) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "POST", agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        console.log("4 body", JSON.stringify(body));
        req.on("close", () => {
          console.log("4 request closed", req.destroyed);
          const answered = req.write("late", () => console.log("4 late write callback"));
          console.log("4 write after close", answered, req.writableEnded);
          done();
        });
      });
    });
    req.on("error", (err) => console.log("4 error", err.code, err.message));
    req.end("body");
  },
);
