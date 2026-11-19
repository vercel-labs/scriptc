// node:http2 respondWithFile/respondWithFD: the response headers go out,
// then the file's bytes (offset/length applied), then END_STREAM. A file
// that cannot be opened reports the fs error on the server stream and
// resets the client stream with NGHTTP2_INTERNAL_ERROR.
import * as fs from "node:fs";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const bodyPath = "tests/corpus/http2-respond-with-file/body.txt";
const server = http2.createServer();
server.on("stream", (stream, headers) => {
  if (headers[":path"] === "/file") {
    stream.respondWithFile(
      bodyPath,
      { ":status": 200, "x-m": "file" },
      { offset: 6, length: 5 },
    );
  } else if (headers[":path"] === "/fd") {
    const fd = fs.openSync(bodyPath, "r");
    stream.respondWithFD(fd, { ":status": 201 }, { offset: 0, length: 5 });
    stream.on("close", () => fs.closeSync(fd));
  } else {
    stream.on("error", (error) => lines.push(`server error ${(error as NodeJS.ErrnoException).code}`));
    stream.respondWithFile("/nonexistent-http2-file");
  }
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const get = (path: string): Promise<void> =>
    new Promise((resolve) => {
      const request = client.request({ ":path": path });
      let body = "";
      request.setEncoding("utf8");
      request.on("response", (headers) =>
        lines.push(`${path} response ${headers[":status"]} ${headers["x-m"]}`),
      );
      request.on("data", (chunk: string) => (body += chunk));
      request.on("error", (error) =>
        lines.push(`${path} error ${(error as NodeJS.ErrnoException).code}`),
      );
      request.on("close", () => {
        lines.push(`${path} body ${JSON.stringify(body)} rst ${request.rstCode}`);
        resolve();
      });
      request.end();
    });
  void (async () => {
    await get("/file");
    await get("/fd");
    await get("/missing");
    client.close(() => {
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
      });
    });
  })();
});
