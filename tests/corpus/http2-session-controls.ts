// Http2Session controls: session.setTimeout() arms the socket's idle timer
// and its callback is a once 'timeout' listener (the event fires too; a
// zero duration disables the timer and removes that callback's
// registration, while a negative or non-finite one throws);
// session.goaway([code][, lastStreamID][, opaqueData]) sends the frames,
// with a zero lastStreamID defaulting to the last processed peer stream;
// ref/unref are the underlying socket's loop reference (Node answers
// undefined).
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

function run(
  label: string,
  sendGoaway: (session: http2.ServerHttp2Session) => void,
  withTimeout: boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    let session: http2.ServerHttp2Session | undefined;
    server.on("session", (opened) => {
      session = opened;
      lines.push(`${label} session`);
      if (!withTimeout) return;
      session.on("timeout", () => lines.push(`${label} timeout event`));
      // a zero duration removes the callback's existing registration
      const removed = (): void => {
        lines.push(`${label} removed callback`);
      };
      session.setTimeout(15, removed);
      session.setTimeout(0, removed);
      // a zero timeout disables the timer and drops the callback (Node)
      session.setTimeout(0, () => lines.push(`${label} zero callback`));
      session.setTimeout(20, () => lines.push(`${label} timeout cb`));
      // the underlying socket's loop reference (Node answers undefined)
      session.ref();
      session.unref();
    });
    server.on("stream", (stream, headers) => {
      lines.push(`${label} stream ${String(headers[":path"])}`);
      if (session !== undefined) sendGoaway(session);
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on(
        "goaway",
        (code: number, lastStreamID: number, opaque: Uint8Array | undefined) => {
          lines.push(
            `${label} goaway ${code} ${lastStreamID} ${
              opaque === undefined ? "none" : Buffer.from(opaque).toString("utf8")
            }`,
          );
        },
      );
      client.on("error", (error) => {
        lines.push(`${label} client error ${String((error as NodeJS.ErrnoException).code)}`);
      });
      const send = () => {
        const request = client.request({ ":path": "/" });
        request.on("response", (responseHeaders) => {
          lines.push(`${label} response ${responseHeaders[":status"]}`);
        });
        request.on("data", (chunk) => lines.push(`${label} data ${String(chunk)}`));
        request.on("error", (error) => {
          lines.push(`${label} request error ${String((error as NodeJS.ErrnoException).code)}`);
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          client.destroy();
          server.close(() => resolve());
        };
        request.on("end", finish);
        request.on("close", finish);
        request.resume();
        request.end();
      };
      if (withTimeout) setTimeout(send, 60);
      else send();
    });
  });
}

function runClientDefault(): Promise<void> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    server.on("session", (opened) => {
      opened.on("goaway", (code: number, lastStreamID: number) => {
        lines.push(`client-default goaway ${code} ${lastStreamID} none`);
      });
    });
    server.on("stream", (stream) => {
      lines.push("client-default stream");
      setTimeout(() => {
        stream.respond({ ":status": 200 });
        stream.end("ok");
      }, 60);
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on("error", () => {});
      const request = client.request({ ":path": "/" });
      request.on("response", (responseHeaders) => {
        lines.push(`client-default response ${responseHeaders[":status"]}`);
        // the client's default lastStreamID counts PEER streams only: the
        // server opened none, so the frame carries 0
        client.goaway();
      });
      request.on("data", (chunk) => lines.push(`client-default data ${String(chunk)}`));
      request.on("end", () => {
        // let the GOAWAY frame reach the server before tearing down
        setTimeout(() => {
          client.destroy();
          server.close(() => resolve());
        }, 50);
      });
      request.resume();
      request.end();
    });
  });
}

function runTimeoutErrors(): Promise<void> {
  return new Promise((resolve) => {
    const server = http2.createServer();
    const fired = (): void => {
      lines.push("timeout-error fired");
    };
    server.on("session", (opened) => {
      for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        try {
          opened.setTimeout(ms);
          lines.push(`timeout-error ${ms} no error`);
        } catch (error) {
          const e = error as Error & { code?: string };
          lines.push(`timeout-error ${ms} ${e.name} ${e.code} ${e.message}`);
        }
      }
      try {
        opened.setTimeout(-1, fired);
        lines.push("timeout-error callback no error");
      } catch (error) {
        const e = error as Error & { code?: string };
        lines.push(`timeout-error callback ${e.name} ${e.code} ${e.message}`);
      }
      // a rejected duration leaves an armed timer and its listener alone
      opened.setTimeout(20, fired);
      try {
        opened.setTimeout(Number.NaN);
      } catch (error) {
        const e = error as Error & { code?: string };
        lines.push(`timeout-error armed-then-rejected ${e.name} ${e.code}`);
      }
    });
    server.on("stream", (stream) => {
      stream.respond({ ":status": 200 });
      stream.end("ok");
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on("error", () => {});
      const request = client.request({ ":path": "/" });
      request.on("data", () => {});
      request.on("end", () => {
        setTimeout(() => {
          client.destroy();
          server.close(() => resolve());
        }, 60);
      });
      request.resume();
      request.end();
    });
  });
}

await run("timed", (session) => session.goaway(), true);
await run("explicit-zero", (session) => session.goaway(0, 0), false);
await run("opaque", (session) => session.goaway(0, 1, Buffer.from("bye")), false);
await runClientDefault();
await runTimeoutErrors();

for (const line of lines) console.log(line);
