// node:http2 respondWithFile/respondWithFD: the response headers go out,
// then the file's bytes (offset/length applied), then END_STREAM. A file
// that cannot be opened reports the fs error on the server stream and
// resets the client stream with NGHTTP2_INTERNAL_ERROR; an unreadable
// descriptor resets without an answer, and a positioned read leaves the
// descriptor's own position alone.
import * as fs from "node:fs";
import * as http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const bodyPath = "tests/corpus/http2-respond-with-file/body.txt";
const largeDir = fs.mkdtempSync(join(tmpdir(), "h2-large-"));
const largePath = join(largeDir, "large.txt");
fs.writeFileSync(largePath, "x".repeat(200000));
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
  } else if (headers[":path"] === "/fd-position") {
    const fd = fs.openSync(bodyPath, "r+");
    const first = Buffer.alloc(2);
    fs.readSync(fd, first, 0, 2, null);
    stream.respondWithFD(fd, { ":status": 200 }, { offset: 6, length: 3 });
    stream.on("close", () => {
      const next = Buffer.alloc(2);
      const n = fs.readSync(fd, next, 0, 2, null);
      lines.push(`fd position ${JSON.stringify(next.toString("utf8", 0, n))}`);
      fs.closeSync(fd);
    });
  } else if (headers[":path"] === "/fd-unreadable") {
    const fd = fs.openSync(bodyPath, "a");
    stream.on("error", (error) =>
      lines.push(`fd-unreadable error ${(error as NodeJS.ErrnoException).code}`),
    );
    stream.on("close", () => {
      lines.push(`fd-unreadable close ${stream.rstCode}`);
      fs.closeSync(fd);
    });
    stream.respondWithFD(fd, { ":status": 200 }, { offset: 0, length: 5 });
  } else if (headers[":path"] === "/range-length") {
    // A caller-supplied length must not survive a range response: Node
    // replaces it with the range's actual byte count.
    stream.respondWithFile(bodyPath, { ":status": 200, "content-length": 999 }, {
      offset: 6,
      length: 5,
    });
  } else if (headers[":path"] === "/onerror") {
    stream.respondWithFile("/nonexistent-http2-file-onerror", { ":status": 200 }, {
      onError: (error) => {
        lines.push(`onerror ${error.code}`);
        stream.respond({ ":status": 404 });
        stream.end("missing");
      },
    });
  } else if (headers[":path"] === "/slow-reader") {
    stream.respondWithFile(largePath, { ":status": 200 });
  } else if (headers[":path"] === "/mutate") {
    stream.respondWithFile(bodyPath, { ":status": 200 }, {
      statCheck: (stat, hdrs) => {
        hdrs["x-check"] = "yes";
        hdrs["x-size"] = String(stat.size);
        hdrs["content-length"] = 999;
        hdrs["set-cookie"] = ["a=1", "b=2"];
        return true;
      },
    });
  } else if (headers[":path"] === "/large") {
    stream.respondWithFile(largePath, { ":status": 200 });
  } else if (headers[":path"] === "/nul") {
    try {
      stream.respondWithFile("bad\u0000path", { ":status": 200 });
    } catch (error) {
      lines.push(`nul throw ${(error as NodeJS.ErrnoException).code}`);
    }
    stream.respond({ ":status": 204 });
    stream.end();
  } else if (headers[":path"] === "/check-false") {
    stream.respondWithFile(bodyPath, { ":status": 200 }, {
      statCheck: (stat, headers) => {
        lines.push(`check stat ${stat.size > 0} status ${headers[":status"]}`);
        return false;
      },
    });
    setTimeout(() => {
      lines.push(`check headersSent ${stream.headersSent}`);
      stream.close();
    }, 30);
  } else if (headers[":path"] === "/late") {
    // The fs error arrives on a later turn, so a listener added right after
    // the call hears it (Node's fs callback).
    stream.respondWithFile("/nonexistent-http2-file-late");
    stream.on("error", (error) => lines.push(`late error ${(error as NodeJS.ErrnoException).code}`));
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
        lines.push(
          `${path} response ${headers[":status"]} ${headers["x-m"]} length ${headers["content-length"]} check ${headers["x-check"]} size ${headers["x-size"]} cookies ${headers["set-cookie"]}`,
        ),
      );
      let held = false;
      request.on("data", (chunk: string) => {
        body += chunk;
        if (path === "/slow-reader" && !held) {
          // Stop reading so the transport backlog builds; the response must
          // resume when the client drains again.
          held = true;
          request.pause();
          setTimeout(() => request.resume(), 120);
        }
      });
      request.on("error", (error) =>
        lines.push(`${path} error ${(error as NodeJS.ErrnoException).code}`),
      );
      request.on("close", () => {
        lines.push(`${path} body ${body.length > 40 ? `${body.length} bytes` : JSON.stringify(body)} rst ${request.rstCode}`);
        resolve();
      });
      request.end();
    });
  void (async () => {
    await get("/file");
    await get("/fd");
    await get("/fd-position");
    await get("/fd-unreadable");
    await get("/missing");
    await get("/range-length");
    await get("/onerror");
    await get("/slow-reader");
    await get("/mutate");
    await get("/large");
    await get("/nul");
    await get("/check-false");
    await get("/late");
    fs.rmSync(largeDir, { recursive: true, force: true });
    client.close(() => {
      server.close(() => {
        for (const line of lines.sort()) console.log(line);
      });
    });
  })();
});
