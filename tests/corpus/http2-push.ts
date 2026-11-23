// node:http2 server push: ServerHttp2Stream.pushStream sends a PUSH_PROMISE
// and reports the promised stream on the next turn, a client session raises
// 'stream' for a promise and the stream's 'push' event for its response,
// pushAllowed follows the peer's ENABLE_PUSH, and an endStream push ends
// the writable half. Keys print sorted; the response date is dropped.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const keys = (record: Record<string, unknown>): string =>
  JSON.stringify(Object.keys(record).filter((k) => k !== "date").sort());
const server = http2.createServer();

server.on("stream", (stream, headers) => {
  const path = String(headers[":path"]);
  if (path === "/disabled") {
    lines.push(`srv disabled pushAllowed ${stream.pushAllowed}`);
    try {
      stream.pushStream({ ":path": "/nope" }, () => {});
    } catch (e) {
      lines.push(`srv disabled throw ${(e as Error & { code?: string }).code}`);
    }
    stream.respond({ ":status": 200 });
    stream.end("disabled");
    return;
  }
  lines.push(`srv pushAllowed ${stream.pushAllowed}`);
  // The promise's header list follows Node's checks before anything is sent.
  try {
    stream.pushStream({ ":path": "/bad", ":foo": "1" }, () => {});
  } catch (e) {
    lines.push(`srv bad headers ${(e as Error & { code?: string }).code}`);
  }
  try {
    stream.pushStream({ ":path": "/bad", connection: "keep-alive" }, () => {});
  } catch (e) {
    lines.push(`srv bad headers ${(e as Error & { code?: string }).code}`);
  }
  stream.pushStream({ ":path": "/pushed", "x-p": "1" }, (err, pushed, promiseHeaders) => {
    lines.push(
      `push cb err ${err ? "set" : "none"} id ${pushed.id} keys ${keys(promiseHeaders)} method ${
        promiseHeaders[":method"]
      } path ${promiseHeaders[":path"]} authority ${promiseHeaders[":authority"]} scheme ${
        promiseHeaders[":scheme"]
      }`,
    );
    pushed.on("error", (e: Error & { code?: string }) => lines.push(`pushed err ${e.code}`));
    try {
      pushed.pushStream({ ":path": "/nested" }, () => {});
    } catch (e) {
      lines.push(`nested throw ${(e as Error & { code?: string }).code}`);
    }
    pushed.respond({ ":status": 201, "x-push": "y" });
    pushed.end("pushed body");
  });
  stream.pushStream(
    { ":method": "HEAD", ":path": "/head" },
    { endStream: true },
    (err, pushed) => {
      lines.push(`head cb err ${err ? "set" : "none"} id ${pushed.id} pushed ${Number(pushed.id) % 2 === 0}`);
      pushed.on("error", (e: Error & { code?: string }) =>
        lines.push(`head err ${e.code} ${e.message}`),
      );
      pushed.respond({ ":status": 200 });
      // The endStream option already ended the writable half.
      pushed.write("late");
    },
  );
  stream.respond({ ":status": 200 });
  stream.end("main body");
});

const report = (client: http2.ClientHttp2Session): void => {
  client.on("stream", (stream, headers) => {
    lines.push(
      `cli stream id ${stream.id} path ${headers[":path"]} pushed ${Number(stream.id) % 2 === 0}`,
    );
    stream.on("push", (responseHeaders) => {
      lines.push(`cli push id ${stream.id} status ${responseHeaders[":status"]}`);
      stream.resume();
    });
    stream.on("data", (chunk: Buffer) => lines.push(`cli data id ${stream.id} ${String(chunk)}`));
    stream.on("end", () => lines.push(`cli end id ${stream.id}`));
    stream.on("close", () => lines.push(`cli close id ${stream.id}`));
  });
};

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const client = http2.connect(`http://127.0.0.1:${port}`);
  const blocked = http2.connect(`http://127.0.0.1:${port}`, { settings: { enablePush: false } });
  let pending = 2;
  const done = (): void => {
    if (--pending > 0) return;
    for (const line of lines.sort()) console.log(line);
    process.exit(0);
  };
  report(client);
  report(blocked);
  client.on("close", done);
  blocked.on("close", done);
  const request = client.request({
    ":path": "/push",
    ":authority": "example.test",
    ":scheme": "https",
  });
  request.resume();
  request.on("end", () => client.close());
  request.end();
  const blockedRequest = blocked.request({ ":path": "/disabled" });
  blockedRequest.resume();
  blockedRequest.on("end", () => blocked.close());
  blockedRequest.end();
});
