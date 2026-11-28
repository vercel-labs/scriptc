// Iterating a server request only after its connection already died: the
// message was destroyed with "aborted" while its body was held, so Node's
// iterator rejects (ECONNRESET) instead of yielding the held bytes or
// staying pending. The iteration starts from the request's own 'close'
// event, which fires after the abort state is in place.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

const watchdog = setTimeout(() => {
  console.log("pending");
  process.exit(2);
}, 1000);

const server = createServer((req) => {
  req.pause();
  req.once("close", () => {
    console.log(`server close destroyed ${req.destroyed} aborted ${req.aborted} complete ${req.complete}`);
    void (async () => {
      try {
        const lengths: number[] = [];
        for await (const chunk of req) lengths.push(chunk.length);
        console.log(`server end ${JSON.stringify(lengths)}`);
      } catch (error) {
        const err = error as Error & { code?: string };
        console.log(`server error ${JSON.stringify(err.message)} ${err.code}`);
      }
      clearTimeout(watchdog);
      server.close();
    })();
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const req = request({
  host: "127.0.0.1",
  port,
  method: "POST",
  path: "/",
  agent: false,
  headers: { "content-length": "30" },
});
req.on("error", () => {});
req.end(Buffer.alloc(30, 67));
setTimeout(() => req.destroy(), 40);

await new Promise<void>((resolve) => setTimeout(resolve, 400));
console.log("done");
