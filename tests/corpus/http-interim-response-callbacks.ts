// The interim response writers' callback forms: the callback fires once the
// 1xx head went out (never for a writeEarlyHints that has no link), and the
// hint values format as Node's do — the link key first, an array of links
// joined ", ", other arrays "a,b", numbers and booleans stringified.
import * as http from "node:http";
import * as net from "node:net";

function attempt(tag: string, write: () => unknown): void {
  try {
    console.log(tag, write());
  } catch (error) {
    const caught = error as NodeJS.ErrnoException;
    console.log(tag, caught.name, caught.code, caught.message);
  }
}

const server = http.createServer((_request, response) => {
  // No link: no head, no callback.
  attempt("no link", () => response.writeEarlyHints({}, () => console.log("no link cb")));
  attempt("empty links", () => response.writeEarlyHints({ link: [] }, () => console.log("empty links cb")));
  // Values outside the declared hint type still reach the runtime, which
  // validates and renders them the way Node does.
  attempt("bad link", () => response.writeEarlyHints({ link: 5 } as any, () => console.log("bad link cb")));
  attempt("bad element", () =>
    response.writeEarlyHints({ link: [5] } as any, () => console.log("bad element cb")),
  );
  attempt("empty string", () => response.writeEarlyHints({ link: "" }, () => console.log("empty string cb")));
  attempt("null hints", () => response.writeEarlyHints(null as any, () => console.log("null cb")));
  attempt("array hints", () => response.writeEarlyHints([] as any, () => console.log("array cb")));
  attempt("function hints", () =>
    response.writeEarlyHints((() => {}) as any, () => console.log("function cb")),
  );
  response.writeContinue(() => console.log("continue cb", response.headersSent));
  response.writeProcessing(() => console.log("processing cb", response.headersSent));
  response.writeEarlyHints(
    { link: ["</a.css>; rel=preload", "</b.css>; rel=preload"], "x-list": ["a", "b"] },
    () => console.log("hints cb"),
  );
  response.writeEarlyHints(
    { link: "</c.css>; rel=preload", "x-count": 2, "x-flag": true } as any,
    () => console.log("values cb"),
  );
  // A capital "Link" is a second own key; Node's hints object overwrites
  // the seeded Link value with it, so one Link line goes out.
  response.writeEarlyHints(
    { link: "</a.css>; rel=preload", Link: "</z.css>; rel=preload" },
    () => console.log("merged cb"),
  );
  console.log("handler done");
  response.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const socket = net.connect(server.address().port, "127.0.0.1");
  let wire = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
  socket.on("data", (chunk: string) => {
    wire += chunk;
  });
  socket.on("end", () => {
    for (const part of wire.split(/(?=HTTP\/1\.1 )/)) {
      const lines = part.split("\r\n");
      if (!lines[0]!.includes("103")) continue;
      console.log("hint", lines.slice(0, -2).join("|"));
    }
    console.log("heads", wire.split("HTTP/1.1 ").slice(1).map((p) => p.split("\r\n")[0]).join(","));
    server.close();
  });
});
