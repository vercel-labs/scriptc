// for await over a ClientHttp2Stream: the body's chunks, the end, a local
// error, an encoding switch, and an early break (which destroys the stream).
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
let left = 0;
function end(): void {
  if (--left === 0) for (const line of lines.sort()) console.log(line);
}
function connect(server: http2.Http2Server): http2.ClientHttp2Session {
  return http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

// 1. a body of three chunks, then the loop's own end
left++;
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.on("close", () => lines.push(`1 server close`));
    stream.respond({ ":status": 200 });
    stream.write("a");
    setTimeout(() => {
      stream.write("b");
      stream.end("c");
    }, 10);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = connect(server);
    const req = client.request({ ":path": "/" });
    let sawEnd = false;
    req.on("end", () => {
      sawEnd = true;
    });
    req.on("close", () => {
      lines.push(`1 close rst=${req.rstCode}`);
      client.destroy();
      server.close(() => end());
    });
    void (async () => {
      for await (const chunk of req) lines.push(`1 chunk ${(chunk as Buffer).toString()}`);
      lines.push(`1 loop done destroyed=${req.destroyed} endSeen=${sawEnd}`);
    })();
  });
}

// 2. an early break destroys the stream
left++;
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
    stream.write("x");
    setTimeout(() => {
      if (!stream.destroyed) stream.end("y");
    }, 50);
    stream.on("close", () =>
      lines.push(`2 server close rst=${stream.rstCode} aborted=${stream.aborted}`),
    );
  });
  server.listen(0, "127.0.0.1", () => {
    const client = connect(server);
    const req = client.request({ ":path": "/" });
    req.on("close", () => {
      lines.push(`2 close rst=${req.rstCode} destroyed=${req.destroyed}`);
      client.destroy();
      server.close(() => end());
    });
    void (async () => {
      for await (const chunk of req) {
        lines.push(`2 chunk ${(chunk as Buffer).toString()}`);
        break;
      }
      lines.push(`2 after break destroyed=${req.destroyed} closed=${req.closed}`);
    })();
  });
}

// 3. a reset mid-body reaches both the loop and the 'error' listener
left++;
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
    stream.write("z");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = connect(server);
    const req = client.request({ ":path": "/" });
    setTimeout(() => req.close(2), 50);
    let closed = false;
    let settled = false;
    const finish = (): void => {
      if (!closed || !settled) return;
      client.destroy();
      server.close(() => end());
    };
    req.on("error", (err) =>
      lines.push(`3 error event ${(err as { code?: string }).code} ${(err as Error).message}`),
    );
    req.on("close", () => {
      lines.push(`3 close rst=${req.rstCode} destroyed=${req.destroyed}`);
      closed = true;
      finish();
    });
    void (async () => {
      try {
        for await (const chunk of req) lines.push(`3 chunk ${(chunk as Buffer).toString()}`);
        lines.push("3 loop done");
      } catch (err) {
        lines.push(`3 caught ${(err as { code?: string }).code} ${(err as Error).message}`);
      }
      settled = true;
      finish();
    })();
  });
}

// 4. setEncoding('utf8'): the loop yields strings
left++;
{
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("hé");
  });
  server.listen(0, "127.0.0.1", () => {
    const client = connect(server);
    const req = client.request({ ":path": "/" });
    req.setEncoding("utf8");
    req.on("close", () => {
      client.destroy();
      server.close(() => end());
    });
    void (async () => {
      for await (const chunk of req) {
        lines.push(`4 chunk type=${typeof chunk} value=${String(chunk)}`);
      }
      lines.push("4 loop done");
    })();
  });
}
