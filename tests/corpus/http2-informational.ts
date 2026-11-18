// Informational responses: additionalHeaders sends a 1xx HEADERS block
// before the final response, the client's 'headers' event reports it with
// its status as a number, and a 100 also raises 'continue' before that
// block's 'headers' listeners (Node's internal listener runs first). A
// trailer send before the response waits for one, an informational block
// after the response started, and the invalid statuses all throw Node's
// errors. Both sides record their lines in the order they happened.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const client: string[] = [];
const server: string[] = [];
const h2server = http2.createServer();
h2server.on("stream", (stream) => {
  const attempt = (name: string, run: () => void): void => {
    try {
      run();
      server.push(`${name} accepted`);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      server.push(`${name} ${failure.code} ${failure.message}`);
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
  h2server.listen(0, "127.0.0.1", () => {
    const session = http2.connect(`http://127.0.0.1:${(h2server.address() as AddressInfo).port}`);
    const request = session.request({ ":path": "/" });
    request.on("headers", (headers) =>
      client.push(`headers ${headers[":status"]} ${typeof headers[":status"]} ${headers["link"] ?? "-"}`),
    );
    request.on("continue", () => client.push("continue"));
    request.on("response", (headers) => client.push(`response ${headers[":status"]}`));
    request.resume();
    request.on("end", () => {
      client.push("end");
      session.close(() => h2server.close(() => resolve()));
    });
    request.end();
  });
});

for (const line of client) console.log(line);
for (const line of server.sort()) console.log(line);
