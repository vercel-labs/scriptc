// stream.setTimeout is an IDLE timer: activity on the stream (writes here)
// postpones it, so a stream that keeps writing never times out; once it
// fires it is done — later activity does not re-arm it (Node's shape).
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

function part(label: string, run: (stream: http2.ServerHttp2Stream, done: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.on("timeout", () => lines.push(`${label} timeout event`));
      stream.setTimeout(60, () => lines.push(`${label} timeout cb`));
      stream.respond({ ":status": 200 });
      run(stream, () => {
        stream.end("done");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const request = client.request({ ":path": "/" });
      request.on("error", () => {});
      request.resume();
      request.on("end", () => {
        client.destroy();
        server.close(() => resolve());
      });
      request.end();
    });
  });
}

await part("burst", (stream, done) => {
  let n = 0;
  const timer = setInterval(() => {
    n++;
    stream.write(`chunk ${n} `);
    if (n === 12) {
      clearInterval(timer);
      lines.push(`burst wrote ${n} chunks`);
      done();
    }
  }, 10);
});

await part("one-shot", (stream, done) => {
  setTimeout(() => stream.write("activity "), 150);
  setTimeout(done, 280);
});

for (const line of lines) console.log(line);
