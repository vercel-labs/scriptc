// Outgoing header values beyond strings: numbers and arrays through
// setHeader/appendHeader, the shape getHeader/getHeaders answer, the
// exact-case order the name readers keep, Node's validation errors, the
// headers-sent refusals, and the `return this` chaining both mutators
// have on the response and the client request.
import * as http from "node:http";

// A value read back keeps the type it was set with — a number, a string, an
// array, or undefined for a name that is not there — so the prints below
// spell each shape instead of narrowing at every call.
function showList(value: string[] | undefined): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function show(value: string | number | string[] | undefined): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function outcome(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    if (error instanceof Error) {
      return `${error.name} ${(error as NodeJS.ErrnoException).code} ${error.message}`;
    }
    return "unexpected";
  }
}

const server = http.createServer((incoming, outgoing) => {
  if (incoming.url === "/echo") {
    console.log(
      "echo",
      incoming.headers["x-num"],
      incoming.headers["x-arr"],
      incoming.headers["x-one"],
      incoming.headers["x-chain"],
      incoming.headers["x-late"] === undefined,
      incoming.headersDistinct["x-arr"]?.join("|"),
    );
    outgoing.end("echo");
    return;
  }
  console.log("fresh", outgoing.getHeaderNames().length);
  outgoing.setHeader("X-Num", 42);
  outgoing.setHeader("x-arr", ["a", "b"]);
  outgoing.setHeader("x-one", ["only"]);
  outgoing.setHeader("X-Str", "text");
  outgoing.appendHeader("X-App", "one");
  outgoing.appendHeader("x-app", ["two", "three"]);
  outgoing.appendHeader("set-cookie", "a=1");
  outgoing.appendHeader("set-cookie", "b=2");
  outgoing.setHeader("x-mix", "one");
  outgoing.appendHeader("x-mix", "two");
  console.log(
    "get",
    outgoing.getHeader("x-num"),
    typeof outgoing.getHeader("x-num"),
    show(outgoing.getHeader("X-ARR")),
    show(outgoing.getHeader("x-one")),
    outgoing.getHeader("x-str"),
  );
  console.log(
    "append",
    show(outgoing.getHeader("x-app")),
    show(outgoing.getHeader("set-cookie")),
    show(outgoing.getHeader("x-mix")),
  );
  console.log(
    "names",
    outgoing.getHeaderNames().join(","),
    outgoing.getRawHeaderNames().join(","),
    Object.getPrototypeOf(outgoing.getHeaders()) === null,
  );
  // A string appended to a number keeps Node's runtime array [1, "two"],
  // which the documented header type cannot name (its array arm holds
  // strings), so read it off the snapshot as a dynamic value.
  outgoing.setHeader("x-mixed", 1);
  outgoing.appendHeader("x-mixed", "two");
  const snapshot: any = outgoing.getHeaders();
  console.log("mixed", JSON.stringify(snapshot["x-mixed"]));
  console.log("has", outgoing.hasHeader("X-NUM"), outgoing.hasHeader("missing"));
  console.log("chained", show(outgoing.setHeader("x-chain", "a").appendHeader("x-chain", "b").getHeader("x-chain")));
  outgoing.removeHeader("X-Num");
  console.log("removed", outgoing.hasHeader("x-num"), outgoing.getRawHeaderNames().join(","));
  console.log("bad name", outcome(() => outgoing.setHeader("bad name", "v")));
  console.log("bad value", outcome(() => outgoing.setHeader("x-t", "line\nbreak")));
  console.log("append bad name", outcome(() => outgoing.appendHeader("bad name", "v")));
  console.log("append bad value", outcome(() => outgoing.appendHeader("x-t", ["ok", "\n"])));
  // A value the checker cannot type (a missing property of an empty
  // object) is undefined at run time: Node's ERR_HTTP_INVALID_HEADER_VALUE.
  const missing = ({} as any).missing;
  console.log("undef set", outcome(() => outgoing.setHeader("x-u", missing)));
  console.log("undef append", outcome(() => outgoing.appendHeader("x-u", missing)));
  outgoing.writeHead(200);
  console.log("late set", outcome(() => outgoing.setHeader("x-late", "v")));
  console.log("late append", outcome(() => outgoing.appendHeader("x-late", "v")));
  console.log("late remove", outcome(() => outgoing.removeHeader("x-app")));
  console.log("sent", outgoing.headersSent);
  outgoing.end("body");
});

const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

await new Promise<void>((resolve) => {
  http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
    console.log(
      "client got",
      response.statusCode,
      response.headers["x-num"],
      JSON.stringify(response.headers["x-arr"]),
      JSON.stringify(response.headers["x-one"]),
      JSON.stringify(response.headers["x-app"]),
      JSON.stringify(response.headers["x-mix"]),
      showList(response.headersDistinct["set-cookie"]),
      JSON.stringify(response.headers["x-chain"]),
    );
    response.resume();
    response.on("end", () => resolve());
  });
});

await new Promise<void>((resolve) => {
  const request = http.request({ host: "127.0.0.1", port, path: "/echo", method: "POST" });
  request.setHeader("X-Num", 7);
  request.setHeader("x-arr", ["c", "d"]);
  request.setHeader("x-one", ["e"]);
  request.appendHeader("X-App", "one");
  request.appendHeader("X-App", ["two", "three"]);
  request.setHeader("x-chain", "one").appendHeader("x-chain", "two");
  console.log(
    "client get",
    request.getHeader("x-num"),
    typeof request.getHeader("x-num"),
    show(request.getHeader("x-arr")),
    show(request.getHeader("x-one")),
    show(request.getHeader("x-app")),
  );
  console.log(
    "client names",
    request.getHeaderNames().join(","),
    request.getRawHeaderNames().join(","),
    JSON.stringify(request.getHeaders()["x-arr"]),
    Object.getPrototypeOf(request.getHeaders()) === null,
    request.getHeaders()["host"] === `127.0.0.1:${port}`,
  );
  console.log("client has", request.hasHeader("X-NUM"), request.hasHeader("missing"));
  request.removeHeader("X-Num");
  console.log("client removed", request.hasHeader("x-num"), request.getRawHeaderNames().join(","));
  console.log("client bad name", outcome(() => request.setHeader("bad name", "v")));
  console.log("client bad value", outcome(() => request.setHeader("x-t", "line\nbreak")));
  console.log("client append bad name", outcome(() => request.appendHeader("bad name", "v")));
  const missing = ({} as any).missing;
  console.log("client undef append", outcome(() => request.appendHeader("x-u", missing)));
  request.flushHeaders();
  console.log("client late set", outcome(() => request.setHeader("x-late", "v")));
  console.log("client late append", outcome(() => request.appendHeader("x-late", "v")));
  console.log("client late remove", outcome(() => request.removeHeader("x-app")));
  request.on("response", (response) => {
    response.resume();
    response.on("end", () => resolve());
  });
  request.end("payload");
});

server.close(() => console.log("closed"));
