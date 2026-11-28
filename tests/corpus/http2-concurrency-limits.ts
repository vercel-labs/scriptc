// The peer's maxConcurrentStreams bounds the client: a request created while
// the limit is reached keeps its HEADERS back (Node's `pending`/deferred
// block) and goes out when a slot frees, and a server never opens a stream
// past what it advertised — the excess HEADERS block is refused with
// REFUSED_STREAM, which the peer sees as ERR_HTTP2_STREAM_ERROR.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

function listen(server: http2.Http2Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http2.Http2Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// A: the client defers a request while the server's advertised limit is full.
{
  const server = http2.createServer({ settings: { maxConcurrentStreams: 1 } });
  server.on("stream", (stream, headers) => {
    lines.push(`A server stream ${String(headers[":path"])}`);
    setTimeout(() => {
      stream.respond({ ":status": 200 });
      stream.end("ok");
    }, 150);
  });
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", () => {});
    const make = (path: string) => {
      const request = client.request({ ":path": path });
      lines.push(`A client ${path} pending=${request.pending}`);
      request.on("ready", () => lines.push(`A client ${path} ready id=${String(request.id)}`));
      request.on("error", () => lines.push(`A client ${path} error`));
      request.on("response", (headers) =>
        lines.push(`A client ${path} response ${String(headers[":status"])}`),
      );
      request.on("close", () => lines.push(`A client ${path} close rst=${request.rstCode}`));
      request.resume();
    };
    make("/one");
    setTimeout(() => make("/two"), 20);
    setTimeout(() => {
      client.destroy();
      resolve();
    }, 700);
  });
  await close(server);
}

// B: the server refuses the HEADERS blocks past the limit it advertised.
{
  const server = http2.createServer();
  server.on("session", (session) => {
    session.settings({ maxConcurrentStreams: 1 });
    session.on("error", (error) => {
      const err = error as Error & { code?: string };
      lines.push(`B server session error ${err.code ?? "-"} ${err.message}`);
    });
  });
  server.on("stream", (stream, headers) => {
    lines.push(`B server stream ${String(headers[":path"])}`);
    stream.on("close", () =>
      lines.push(`B server stream close ${String(headers[":path"])} rst=${stream.rstCode}`),
    );
    setTimeout(() => {
      if (!stream.destroyed) {
        stream.respond({ ":status": 200 });
        stream.end("ok");
      }
    }, 300);
  });
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", () => {});
    const make = (path: string) => {
      const request = client.request({ ":path": path });
      request.on("error", (error) => {
        const err = error as Error & { code?: string };
        lines.push(`B client ${path} error ${err.code ?? "-"} ${err.message}`);
      });
      request.on("close", () => lines.push(`B client ${path} close rst=${request.rstCode}`));
      request.on("response", (headers) =>
        lines.push(`B client ${path} response ${String(headers[":status"])}`),
      );
      request.resume();
    };
    make("/one");
    make("/two");
    setTimeout(() => {
      client.close(() =>
        close(server).then(() => {
          resolve();
        }),
      );
    }, 500);
  });
}


// C: closing the session while a request is deferred: the held-back block
// goes out as the session closes (it gets its id and 'ready'), the peer
// refuses it past the limit, and the graceful-close callback runs.
{
  const server = http2.createServer();
  server.on("session", (session) => session.settings({ maxConcurrentStreams: 1 }));
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
    stream.write("x");
    if (String(headers[":path"]) === "/one") setTimeout(() => stream.end(), 500);
    else stream.end();
  });
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", () => {});
    client.on("remoteSettings", (settings) => {
      if (String(settings.maxConcurrentStreams) !== "1") return;
      const one = client.request({ ":path": "/one" });
      one.on("error", () => {});
      one.resume();
      setTimeout(() => {
        const two = client.request({ ":path": "/two" });
        two.on("error", (error) => {
          const err = error as Error & { code?: string };
          lines.push(`C client /two error ${err.code ?? "-"} ${err.message}`);
        });
        two.on("ready", () => lines.push(`C client /two ready id=${String(two.id)}`));
        two.on("close", () => lines.push(`C client /two close rst=${two.rstCode}`));
        setTimeout(() => {
          client.close(() => {
            lines.push("C close callback");
            close(server).then(() => resolve());
          });
        }, 50);
      }, 30);
    });
  });
}

// D: a completed response whose body nobody read must not keep the peer's
// concurrency slot: the next request goes out and answers.
{
  const server = http2.createServer();
  server.on("session", (session) => session.settings({ maxConcurrentStreams: 1 }));
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end("body");
  });
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", () => {});
    client.on("remoteSettings", (settings) => {
      if (String(settings.maxConcurrentStreams) !== "1") return;
      const one = client.request({ ":path": "/one" });
      one.on("error", () => {});
      setTimeout(() => {
        const two = client.request({ ":path": "/two" });
        two.on("error", (error) => {
          const err = error as Error & { code?: string };
          lines.push(`D client /two error ${err.code ?? "-"}`);
        });
        two.on("ready", () => lines.push(`D client /two ready id=${String(two.id)}`));
        two.on("response", (headers) =>
          lines.push(`D client /two response ${String(headers[":status"])}`),
        );
        two.resume();
      }, 60);
      setTimeout(() => {
        client.destroy();
        close(server).then(() => resolve());
      }, 500);
    });
  });
}

// E: destroying a request that is still deferred must only end that request —
// no frame for a stream without an id, and the session stays usable.
{
  const server = http2.createServer();
  server.on("session", (session) => session.settings({ maxConcurrentStreams: 1 }));
  server.on("stream", (stream) => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200 });
    stream.write("x");
    setTimeout(() => stream.end(), 500);
  });
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on("error", (error) => lines.push(`E client session error ${(error as Error).message}`));
    client.on("remoteSettings", (settings) => {
      if (String(settings.maxConcurrentStreams) !== "1") return;
      const one = client.request({ ":path": "/one" });
      one.on("error", () => {});
      one.resume();
      setTimeout(() => {
        const two = client.request({ ":path": "/two" });
        two.on("error", () => {});
        two.on("close", () => lines.push(`E client /two close rst=${two.rstCode}`));
        setTimeout(() => {
          two.destroy();
          lines.push(`E destroyed ${two.destroyed}`);
        }, 50);
        setTimeout(() => {
          lines.push(`E session alive ${!client.destroyed}`);
          client.destroy();
          close(server).then(() => resolve());
        }, 400);
      }, 30);
    });
  });
}

for (const line of lines.sort()) console.log(line);
