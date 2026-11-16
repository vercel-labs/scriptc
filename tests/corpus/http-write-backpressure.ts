// OutgoingMessage write backpressure: write() answers whether the buffer is
// still below Node's 64 KiB high-water mark, writableLength and
// writableNeedDrain report that buffer, and a false answer's 'drain' follows
// once the bytes are out. Both directions: a response streaming a body and a
// request uploading one.
import * as http from "node:http";

const BIG = 100000;

const server = http.createServer((req, res) => {
  if (req.url === "/upload") {
    let got = 0;
    req.on("data", (chunk: Buffer) => {
      got += chunk.length;
    });
    req.on("end", () => {
      console.log("server body", got, req.complete);
      res.end("ok");
    });
    return;
  }
  if (req.url === "/small") {
    res.on("drain", () => console.log("small drain (unexpected)"));
    const first = res.write("a");
    const second = res.write("b");
    console.log("small", first, second, res.writableNeedDrain, res.writableLength === 0);
    res.end();
    return;
  }
  console.log("hwm", res.writableHighWaterMark, "objectMode", res.writableObjectMode);
  console.log("start", res.writableLength, res.writableNeedDrain);
  const accepted = res.write("x".repeat(BIG));
  console.log("big", accepted, res.writableLength > BIG, res.writableNeedDrain, res.headersSent);
  res.once("drain", () => {
    console.log("drain", res.writableLength, res.writableNeedDrain, res.writableEnded);
    res.end("done");
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;

  const small = (): void => {
    http.get({ host: "127.0.0.1", port, path: "/small" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        console.log("small response", res.statusCode);
        big();
      });
    });
  };

  const big = (): void => {
    const req = http.request({ host: "127.0.0.1", port, path: "/big" }, (res) => {
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });
      res.on("end", () => {
        console.log("big response", res.statusCode, size);
        upload();
      });
    });
    req.end();
  };

  const upload = (): void => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/upload", method: "POST" },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          console.log("upload", res.statusCode);
          server.close();
        });
      },
    );
    console.log("req hwm", req.writableHighWaterMark, req.writableObjectMode, req.writableNeedDrain);
    const accepted = req.write("y".repeat(BIG));
    console.log("req big", accepted, req.writableLength > BIG, req.writableNeedDrain);
    req.once("drain", () => {
      console.log("req drain", req.writableLength, req.writableNeedDrain);
      req.end();
    });
  };

  small();
});
