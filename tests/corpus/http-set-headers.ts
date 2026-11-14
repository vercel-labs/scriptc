// OutgoingMessage.setHeaders(): a Headers or Map sets every entry through
// setHeader, keeping every Set-Cookie value as its own line and applying
// them last, so an earlier entry cannot overwrite them.
import * as http from "node:http";

const server = http.createServer((request, response) => {
  const path = request.url;
  if (path === "/map") {
    const map = new Map<string, string | readonly string[]>();
    map.set("x-a", "one");
    map.set("Set-Cookie", "case=kept");
    map.set("set-cookie", ["a=1", "b=2"]);
    map.set("x-b", "two");
    response.setHeaders(map);
    console.log(
      "map",
      response.getHeader("x-a"),
      response.getHeader("set-cookie"),
      response.getHeader("Set-Cookie"),
    );
    console.log("map names", response.getHeaderNames().join(","));
    response.end("map");
    return;
  }
  if (path === "/headers") {
    const headers = new Headers();
    headers.append("x-b", "2");
    headers.append("X-A", "1");
    headers.append("set-cookie", "c=3");
    headers.append("set-cookie", "d=4");
    response.setHeaders(headers);
    console.log(
      "headers",
      response.getHeader("x-a"),
      response.getHeader("x-b"),
      response.getHeader("set-cookie"),
    );
    response.end("headers");
    return;
  }
  if (path === "/sent") {
    response.writeHead(200);
    try {
      response.setHeaders(new Map([["x-late", "1"]]));
    } catch (error) {
      const e = error as Error;
      console.log("sent", e.name, (e as { code?: string }).code, e.message);
    }
    response.end("sent");
    return;
  }
  if (path === "/number") {
    const map = new Map<string, number | string>();
    map.set("x-n", 5);
    map.set("x-s", "s");
    response.setHeaders(map);
    console.log("number", response.getHeader("x-n"), response.getHeader("x-s"));
    response.end("number");
    return;
  }
  // The client set the headers of its own request: echo what arrived.
  console.log(
    "echo",
    request.headers["x-c"],
    request.headers["x-d"],
    request.headersDistinct["set-cookie"],
  );
  response.end("echo");
});

const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

function get(path: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path }, (response) => {
      console.log(
        "client",
        path,
        response.statusCode,
        response.headers["x-a"],
        response.headers["x-b"],
        response.headers["x-n"],
      );
      response.resume();
      response.on("end", () => resolve());
    });
    request.on("error", (error) => {
      console.log("client error", error.message);
      resolve();
    });
  });
}

for (const path of ["/map", "/headers", "/sent", "/number"]) await get(path);

// The ClientRequest is an OutgoingMessage too.
await new Promise<void>((resolve) => {
  const request = http.request({ host: "127.0.0.1", port, path: "/echo" });
  request.setHeaders(new Map([["x-c", "3"]]));
  request.setHeaders(new Map([["x-d", "4"]]));
  console.log("request headers", request.getHeader("x-c"), request.getHeader("x-d"));
  request.end();
  request.on("response", (response) => {
    response.resume();
    response.on("end", () => resolve());
  });
  request.on("error", (error) => {
    console.log("request error", error.message);
    resolve();
  });
});

server.close(() => console.log("closed"));
