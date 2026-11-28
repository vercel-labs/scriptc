// A server stream's close(code) ends the body cleanly — Node's closeStream
// ends the writable side first, so the peer sees END_STREAM and no reset —
// and a loop that leaves early leaves its sibling iterators rejecting with
// the AbortError the destroy carries.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

async function resetCase(): Promise<void> {
  await new Promise<void>((done) => {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200 });
      stream.write("first-chunk");
      // NGHTTP2_INTERNAL_ERROR: the local close code, never on the wire
      setTimeout(() => stream.close(2), 20);
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on("error", () => {});
      const req = client.request({ ":path": "/" });
      req.on("error", (err) =>
        lines.push(`reset req error ${String((err as { code?: string }).code)}`),
      );
      req.on("close", () => lines.push(`reset close rst=${req.rstCode}`));
      void (async () => {
        try {
          for await (const chunk of req) lines.push(`reset chunk ${(chunk as Buffer).toString()}`);
          lines.push("reset loop done");
        } catch (err) {
          lines.push(`reset loop threw ${(err as Error).name}`);
        }
        setTimeout(() => {
          client.destroy();
          server.close(() => done());
        }, 60);
      })();
    });
  });
}

async function breakCase(): Promise<void> {
  await new Promise<void>((done) => {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.respond({ ":status": 200 });
      stream.write("a");
      setTimeout(() => stream.write("b"), 20);
      setTimeout(() => stream.end("c"), 40);
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const req = client.request({ ":path": "/" });
      let finished = 0;
      const finish = (): void => {
        if (++finished < 3) return;
        setTimeout(() => {
          client.destroy();
          server.close(() => done());
        }, 60);
      };
      const loop = (tag: string, breaker: boolean): void => {
        void (async () => {
          try {
            for await (const chunk of req) {
              lines.push(`break ${tag} chunk ${(chunk as Buffer).toString()}`);
              if (breaker) break;
            }
            lines.push(`break ${tag} done`);
          } catch (err) {
            lines.push(`break ${tag} threw ${(err as Error).name}`);
          }
          finish();
        })();
      };
      loop("first", true);
      loop("second", false);
      loop("third", false);
    });
  });
}

async function main(): Promise<void> {
  await resetCase();
  await breakCase();
  for (const line of lines.sort()) console.log(line);
}

void main();
