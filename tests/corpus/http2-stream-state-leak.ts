// Reading stream.state repeatedly on a fresh client stream must not leak:
// each read builds one snapshot object (the idle snapshot included) and the
// caller owns it. The sanitized lane's reference audit is the assertion.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("connect", () => {
      const request = client.request({ ":path": "/" });
      // before the next tick initializes it, the stream is still IDLE
      let idleReads = 0;
      for (let i = 0; i < 20; i++) {
        const state = request.state;
        if (state.state === 1 && state.weight === 0 && state.localWindowSize === 0) idleReads += 1;
      }
      lines.push(`idle reads ${idleReads}`);
      request.resume();
      request.on("end", () => {
        client.close(() => {
          server.close(() => resolve());
        });
      });
      request.end();
    });
  });
});

for (const line of lines) console.log(line);
