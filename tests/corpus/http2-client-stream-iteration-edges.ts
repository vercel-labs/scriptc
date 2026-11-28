// Edge shapes of `for await` over a client HTTP/2 stream: an error that
// lands while the loop body awaits other work still reaches the loop, a
// trailer block ends the body, and two live iterators share one stream the
// way Node's readable does.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

async function drive(
  label: string,
  server: http2.Http2Server,
  run: (req: http2.ClientHttp2Stream) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on("error", () => {});
      const req = client.request({ ":path": "/" });
      req.on("error", (err) =>
        lines.push(`${label} req error ${String((err as { code?: string }).code)}`),
      );
      req.on("close", () => lines.push(`${label} req close rst=${req.rstCode}`));
      void (async () => {
        await run(req);
        setTimeout(() => {
          client.destroy();
          server.close(() => resolve());
        }, 120);
      })();
    });
  });
}

async function main(): Promise<void> {
  // An error arrives while the loop body is awaiting other work: the next
  // read must reject with it, not report a finished body.
  {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200 });
      stream.write("a");
    });
    await drive("error", server, async (req) => {
      // the reset lands while the loop body is awaiting the timer
      setTimeout(() => req.close(2), 40);
      try {
        for await (const chunk of req) {
          lines.push(`error chunk ${(chunk as Buffer).toString()}`);
          await new Promise((done) => setTimeout(done, 100));
        }
        lines.push("error loop done");
      } catch (err) {
        lines.push(
          `error caught ${String((err as { code?: string }).code)} ${(err as Error).message}`,
        );
      }
    });
  }

  // The body ends with a trailer block.
  {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200 }, { waitForTrailers: true });
      stream.write("a");
      stream.on("wantTrailers", () => stream.sendTrailers({ "x-trailer": "1" }));
      stream.end();
    });
    await drive("trailers", server, async (req) => {
      for await (const chunk of req) lines.push(`trailers chunk ${(chunk as Buffer).toString()}`);
      lines.push("trailers loop done");
    });
  }

  // Two live iterators over one stream: the oldest parked read takes each
  // chunk, and both end with the stream.
  {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.respond({ ":status": 200 });
      // each chunk lands while both readers are parked: the oldest iterator
      // keeps taking them, as Node's readable serves them
      stream.write("a");
      setTimeout(() => {
        stream.write("b");
        stream.end();
      }, 30);
    });
    await drive("shared", server, async (req) => {
      const first = (async () => {
        for await (const chunk of req) lines.push(`shared first ${(chunk as Buffer).toString()}`);
        lines.push("shared first done");
      })();
      const second = (async () => {
        for await (const chunk of req) lines.push(`shared second ${(chunk as Buffer).toString()}`);
        lines.push("shared second done");
      })();
      await Promise.all([first, second]);
    });
  }

  for (const line of lines.sort()) console.log(line);
}

void main();
