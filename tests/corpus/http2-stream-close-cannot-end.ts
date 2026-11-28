// close(code) on a response that cannot end on its own — output still queued
// behind the peer's flow-control window, or a trailer block still expected —
// resets the stream: the peer reports close and the stream error, never a
// stream that waits forever.
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";

const lines: string[] = [];

async function run(label: string, mode: "blocked" | "trailers"): Promise<void> {
  await new Promise<void>((resolve) => {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.on("error", () => {});
      if (mode === "trailers") {
        stream.respond({ ":status": 200 }, { waitForTrailers: true });
        stream.write("a");
      } else {
        stream.respond({ ":status": 200 });
        stream.write(Buffer.alloc(200 * 1024));
      }
      setTimeout(() => stream.close(2), 50);
    });
    server.listen(0, "127.0.0.1", () => {
      const client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      client.on("error", () => {});
      const req = client.request({ ":path": "/" });
      let settled = false;
      const finish = (tag: string): void => {
        if (settled) return;
        settled = true;
        lines.push(`${label} ${tag}`);
        client.destroy();
        server.close(() => resolve());
      };
      const timer = setTimeout(() => finish("watchdog"), 800);
      req.on("error", (err) => {
        const e = err as Error & { code?: string };
        lines.push(`${label} client error ${String(e.code)}`);
      });
      req.on("close", () => {
        lines.push(`${label} close rst=${req.rstCode}`);
        clearTimeout(timer);
        setTimeout(() => finish("settled"), 60);
      });
      if (mode === "trailers") req.resume();
    });
  });
}

await run("blocked", "blocked");
await run("trailers", "trailers");
for (const line of lines.sort()) console.log(line);
