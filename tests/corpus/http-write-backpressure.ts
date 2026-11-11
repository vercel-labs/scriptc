// write()'s backpressure answer and the numbers behind it: a corked
// ServerResponse holds its head and each chunk's framing, so writableLength
// grows by 16384 + 8 per 16 KiB write while the head counts once;
// writableNeedDrain tracks the false answer once writableLength reaches the
// 64 KiB high water mark; uncork() flushes the cork and emits 'drain'
// synchronously as its last step, once the buffer is empty. The client
// request's writable side answers the same way, and a write after the
// flush reports the empty buffer again.
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";

const big = "x".repeat(16384);

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
type Client = (port: number, done: () => void) => void;

function exchange(handler: Handler, drive: Client): Promise<void> {
  return new Promise<void>((done) => {
    const server = createServer(handler);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      drive(port, () => {
        setTimeout(() => {
          server.close();
          done();
        }, 10);
      });
    });
  });
}

function simpleClient(port: number, done: () => void): void {
  const outbound = request({ port, method: "POST", agent: false }, (response) => {
    let bytes = 0;
    response.on("data", (chunk: Uint8Array) => {
      bytes += chunk.length;
    });
    response.on("end", () => {
      console.log("response bytes", bytes);
      done();
    });
  });
  outbound.end("ping");
}

async function main(): Promise<void> {
  // 1. The response's writable side, corked across ten 16 KiB writes.
  console.log("exchange 1");
  await exchange(
    (req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.on("drain", () => {
          console.log("drain", res.writableLength, res.writableNeedDrain);
        });
        console.log("start", res.writableHighWaterMark, res.writableLength, res.writableNeedDrain);
        res.cork();
        for (let i = 0; i < 10; i++) {
          const accepted = res.write(big);
          console.log("write", i, accepted, res.writableLength, res.writableNeedDrain);
        }
        res.uncork();
        console.log("uncorked", res.writableLength, res.writableNeedDrain);
        res.end();
        console.log("ended", res.writableLength === 0);
      });
    },
    simpleClient,
  );

  // 2. The last write that crosses the mark answers false once; a write
  // that keeps the buffer above it answers false again, and the single
  // 'drain' at uncork clears writableNeedDrain.
  console.log("exchange 2");
  await exchange(
    (req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        let drains = 0;
        res.on("drain", () => {
          drains++;
          console.log("drain", drains, res.writableLength, res.writableNeedDrain);
        });
        res.cork();
        console.log("first", res.write(big), res.writableLength);
        console.log("second", res.write(big), res.writableLength);
        console.log("third", res.write(big), res.writableLength);
        console.log("fourth", res.write(big), res.writableLength);
        console.log("fifth", res.write(big), res.writableLength);
        res.uncork();
        console.log("after uncork", drains, res.writableNeedDrain);
        res.write("tail");
        console.log("tail", res.writableLength, res.writableNeedDrain);
        res.end();
      });
    },
    simpleClient,
  );

  // 3. The client request's writable side: its own head is held while
  // corked, so the same false answer arrives; the port's digits keep the
  // head's length out of the program's output.
  console.log("exchange 3");
  await exchange(
    (req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.end("ok");
      });
    },
    (port, done) => {
      const outbound = request({ port, method: "POST", agent: false }, (response) => {
        response.resume();
        response.on("end", () => {
          console.log("client finished", outbound.writableEnded, outbound.writableLength === 0);
          done();
        });
      });
      outbound.on("drain", () => {
        console.log("client drain", outbound.writableLength === 0, outbound.writableNeedDrain);
      });
      outbound.cork();
      for (let i = 0; i < 6; i++) {
        const accepted = outbound.write(big);
        console.log("client write", i, accepted, outbound.writableNeedDrain);
      }
      outbound.uncork();
      console.log("client uncorked", outbound.writableLength === 0, outbound.writableNeedDrain);
      outbound.end();
    },
  );
}

main();
