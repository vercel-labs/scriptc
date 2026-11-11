// ClientRequest.setHeaders() with array values: every element is validated
// before the store changes, each value keeps its own line and the header's
// place, and later setHeader/appendHeader calls neither shrink the store
// behind its recorded capacity nor desynchronize names, values and kinds.
import * as http from "node:http";

const server = http.createServer((request, response) => {
  console.log("cookie", JSON.stringify(request.headers.cookie));
  console.log("x-list", JSON.stringify(request.headers["x-list"]));
  console.log("x-late", JSON.stringify(request.headers["x-late"]));
  response.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const request = http.request({ host: "127.0.0.1", port, path: "/", agent: false }, (response) => {
    response.resume();
    response.on("end", () => server.close(() => console.log("closed")));
  });
  request.on("error", (error) => console.log("client error", error.code));
  // Duplicate cookie values reach the wire as one joined line, the other
  // array values as one line each.
  request.setHeaders(
    new Map([
      ["cookie", ["a=1", "b=2", "c=3"]],
      ["x-list", ["one", "two"]],
    ]),
  );
  // Later mutations: the store grew by two lines, so this insertion must
  // stay inside the (still capacity-sized) allocation.
  request.setHeader("x-late", "value");
  request.appendHeader("x-list", "three");
  const headers = request.getHeaders();
  console.log("cookie getHeader", String(request.getHeader("cookie")));
  console.log("x-list getHeader", String(request.getHeader("x-list")));
  console.log("raw names", JSON.stringify(request.getRawHeaderNames()));
  console.log("headers", String(headers.cookie), String(headers["x-list"]), String(headers["x-late"]));
  // A later array value that would inject a header line is refused before
  // any of the entry's values reach the store.
  try {
    request.setHeaders(new Map([["x-bad", ["ok", "bad\r\nInjected: yes"]]]));
    console.log("bad accepted", String(request.getHeader("x-bad")));
  } catch (error) {
    console.log("bad refused", error.code);
  }
  request.end();
});
