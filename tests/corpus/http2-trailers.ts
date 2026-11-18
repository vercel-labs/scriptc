// Stream-level trailers: a response started with waitForTrailers sends its
// HEADERS without END_STREAM, 'wantTrailers' fires once the body is out,
// and the trailer block ends the stream. The client reports the trailer
// block through 'trailers' before 'end'. Each phase prints sorted lines.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

// The happy path: response, wantTrailers, the trailer record, end.
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200, "x-a": "1" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => {
      lines.push("server wantTrailers");
      stream.sendTrailers({ "x-trailer": "yes" });
    });
    stream.end("body");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": "/trailers" });
      request.setEncoding("utf8");
      request.on("response", (headers) => lines.push(`response ${headers[":status"]} ${headers["x-a"]}`));
      request.on("data", (chunk: string) => lines.push(`data ${chunk}`));
      request.on("trailers", (trailers) => lines.push(`trailers ${trailers["x-trailer"]}`));
      request.on("end", () => lines.push("end"));
      request.on("close", () => client.close(() => server.close(() => resolve())));
      request.end();
    });
  });
}

// A response that waits for trailers but sends none still ends: the empty
// block is invisible to the peer.
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 204 }, { waitForTrailers: true });
    stream.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": "/empty" });
      request.on("response", (headers) => lines.push(`empty response ${headers[":status"]}`));
      request.on("trailers", () => lines.push("empty trailers"));
      request.on("end", () => lines.push("empty end"));
      request.on("close", () => client.close(() => server.close(() => resolve())));
      request.end();
    });
  });
}

// A one-shot listener that sends the block on a later turn still owns the
// stream: no empty block closes it first.
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 }, { waitForTrailers: true });
    stream.once("wantTrailers", () => {
      setTimeout(() => stream.sendTrailers({ "x-late": "1" }), 10);
    });
    stream.end("late");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": "/late" });
      request.on("trailers", (trailers) => lines.push(`late trailers ${trailers["x-late"]}`));
      request.resume();
      request.on("end", () => lines.push("late end"));
      request.on("close", () => client.close(() => server.close(() => resolve())));
      request.end();
    });
  });
}

// A listener registered immediately AFTER end() still hears the event:
// Node emits 'wantTrailers' from the write completion, not inside the
// synchronous end() call, so the subsequent registration is in place.
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 }, { waitForTrailers: true });
    stream.end("after");
    stream.on("wantTrailers", () => {
      lines.push("after wantTrailers");
      stream.sendTrailers({ "x-after": "1" });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": "/after" });
      request.on("trailers", (trailers) => lines.push(`after trailers ${trailers["x-after"]}`));
      request.resume();
      request.on("end", () => lines.push("after end"));
      request.on("close", () => client.close(() => server.close(() => resolve())));
      request.end();
    });
  });
}

for (const line of lines.sort()) console.log(line);
