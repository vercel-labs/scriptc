// response.writeInformation(statusCode[, headers][, callback]): Node's
// general informational (1xx) writer that writeContinue, writeProcessing
// and writeEarlyHints route through. The head goes out with the given
// headers and no body; the status line's reason comes from STATUS_CODES.
import * as http from "node:http";

const server = http.createServer((request, response) => {
  const path = request.url;
  if (path === "/103") {
    const written = response.writeInformation(103, { link: "</a.css>; rel=preload" });
    console.log("written", written);
    response.writeInformation(102);
    response.end("info");
    return;
  }
  if (path === "/stateful") {
    console.log(
      "before",
      response.headersSent,
      response.writableEnded,
      response.statusCode,
    );
    response.writeInformation(100);
    console.log("after", response.headersSent, response.writableEnded, response.statusCode);
    response.end("stateful");
    return;
  }
  if (path === "/invalid") {
    for (const code of [101, 200, 99, 100.5]) {
      try {
        response.writeInformation(code);
        console.log("no throw", code);
      } catch (error) {
        const e = error as Error;
        console.log("invalid", code, e.name, (e as { code?: string }).code, e.message);
      }
    }
    response.end("invalid");
    return;
  }
  if (path === "/sent") {
    response.writeHead(200);
    try {
      response.writeInformation(103);
    } catch (error) {
      const e = error as Error;
      console.log("sent", e.name, (e as { code?: string }).code, e.message);
    }
    response.end("sent");
    return;
  }
  if (path === "/bad-header") {
    try {
      response.writeInformation(103, { "bad header": "x" });
    } catch (error) {
      const e = error as Error;
      console.log("bad-header", e.name, (e as { code?: string }).code, e.message);
    }
    response.end("bad-header");
    return;
  }
  response.end();
});

const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

function get(path: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path }, (response) => {
      console.log("client", path, response.statusCode);
      response.resume();
      response.on("end", () => resolve());
    });
    request.on("information", (info) => {
      console.log(
        "information",
        path,
        info.statusCode,
        JSON.stringify(info.statusMessage),
        JSON.stringify(info.headers["link"]),
      );
    });
    request.on("continue", () => console.log("continue", path));
    request.on("error", (error) => {
      console.log("client error", error.message);
      resolve();
    });
  });
}

for (const path of ["/103", "/stateful", "/invalid", "/sent", "/bad-header"]) await get(path);

server.close(() => console.log("closed"));
