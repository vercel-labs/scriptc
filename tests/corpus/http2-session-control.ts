// Session control members: ref()/unref() hand the session back, the
// transport's reference state follows them, setLocalWindowSize() raises the
// connection receive window, and 'frameError' registrations are accepted on
// both a session and a stream (no frame this side sends fails to go out, so
// neither fires). The argument checks throw Node's errors.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const server = http2.createServer();
server.on("stream", (stream) => {
  stream.on("frameError", () => lines.push("server stream frame error"));
  stream.respond({ ":status": 200 });
  stream.end("ok");
});
server.on("session", (session) => {
  session.on("frameError", () => lines.push("server session frame error"));
});

function check(what: string, fn: () => void): void {
  try {
    fn();
    lines.push(`${what} accepted`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    lines.push(`${what} ${failure.code} ${failure.message}`);
  }
}

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("connect", () => {
      client.on("frameError", () => lines.push("client frame error"));
      client.unref();
      client.ref();
      client.setLocalWindowSize(65535 * 2);
      lines.push(`raised window ${client.closed} ${client.destroyed}`);
      check("window negative", () => client.setLocalWindowSize(-1));
      check("window fraction", () => client.setLocalWindowSize(1.5));
      check("timeout negative", () => client.setTimeout(-5));
      check("timeout nan", () => client.setTimeout(Number.NaN));
      const request = client.request({ ":path": "/" });
      request.on("frameError", () => lines.push("client stream frame error"));
      request.resume();
      request.on("end", () =>
        client.close(() =>
          server.close(() => {
            for (const line of lines.sort()) console.log(line);
            resolve();
          }),
        ),
      );
      request.end();
    });
  });
});
