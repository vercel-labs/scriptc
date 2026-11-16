// Informational responses: additionalHeaders sends a 1xx HEADERS block
// before the final response, the client's 'headers' event reports it with
// its status, and a 100 also raises 'continue'. A trailer send before the
// response waits for one, an informational block after the response
// started, and the invalid statuses all throw Node's errors.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  const attempt = (name: string, run: () => void): void => {
    try {
      run();
      lines.push(`${name} accepted`);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      lines.push(`${name} ${failure.code} ${failure.message}`);
    }
  };
  attempt("trailers before ready", () => stream.sendTrailers({ "x": "1" }));
  attempt("info 200", () => stream.additionalHeaders({ ":status": 200 }));
  attempt("info 101", () => stream.additionalHeaders({ ":status": 101 }));
  attempt("info pseudo", () => stream.additionalHeaders({ ":path": "/x" }));
  stream.additionalHeaders({ ":status": 103, link: "</s.css>" });
  stream.additionalHeaders({ ":status": 100 });
  stream.respond({ ":status": 200 });
  attempt("info after respond", () => stream.additionalHeaders({ ":status": 103 }));
  stream.end("ok");
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = client.request({ ":path": "/" });
    request.on("headers", (headers, flags) =>
      lines.push(`headers ${headers[":status"]} ${headers["link"] ?? "none"} ${flags}`),
    );
    request.on("continue", () => lines.push("continue"));
    request.on("response", (headers) => lines.push(`response ${headers[":status"]}`));
    request.resume();
    request.on("end", () => {
      lines.push("end");
      client.close(() => server.close(() => resolve()));
    });
    request.end();
  });
});

for (const line of lines.sort()) console.log(line);
