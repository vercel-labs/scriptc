// node:http2 idle timeouts: session.setTimeout() and its one-shot
// callback, a stream's setTimeout() (both ends), the server's
// Http2Server.setTimeout() arming each accepted session (its 'timeout'
// listeners hear the session), and the server timeout with no listener,
// which destroys the session. Idle timers are wall-clock events, so the
// recorded lines are sorted.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A server idle timeout, heard through the session's own callback and the
// server's 'timeout' event.
await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.timeout = 40;
  server.setTimeout(40, () => lines.push("server timeout cb"));
  server.on("timeout", (session) => lines.push(`server timeout ev ${session.type}`));
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("connect", () => {
      void delay(200).then(() => {
        client.destroy();
        server.close(() => resolve());
      });
    });
  });
});

// Session and stream timers on an open client stream.
await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.setTimeout(30, () => lines.push("stream timeout server cb"));
    stream.on("timeout", () => lines.push("stream timeout server ev"));
    stream.respond({ ":status": 200 });
  });
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("connect", () => {
      client.setTimeout(400, () => lines.push("session timeout client cb"));
      const request = client.request({ ":path": "/" });
      request.setTimeout(50, () => lines.push("stream timeout client cb"));
      request.on("timeout", () => lines.push("stream timeout client ev"));
      request.resume();
      void delay(200).then(() => {
        client.destroy();
        server.close(() => resolve());
      });
    });
  });
});

// The server timeout with no listener destroys the session.
await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.setTimeout(40);
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("close", () => lines.push("unhandled server timeout closed the session"));
    client.on("error", () => {});
    void delay(200).then(() => {
      client.destroy();
      server.close(() => resolve());
    });
  });
});


// Activity refreshes the session timer: five pings spaced inside the
// timeout keep it from firing, and it fires once the session goes idle
// again.
await new Promise<void>((resolve) => {
  const server = http2.createServer();
  server.listen(0, "127.0.0.1", () => {
    const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    let fired = 0;
    client.on("connect", () => {
      client.setTimeout(80);
      client.on("timeout", () => (fired += 1));
      let pings = 0;
      const pinger = setInterval(() => {
        client.ping(() => {});
        pings += 1;
        if (pings === 5) clearInterval(pinger);
      }, 30);
      void delay(420).then(() => {
        lines.push(`activity refreshed timeouts ${fired}`);
        client.destroy();
        server.close(() => resolve());
      });
    });
  });
});

for (const line of lines.sort()) console.log(line);
