// net.Socket write() backpressure, as in Node 24: write answers false when
// the writes not yet completely sent reach the 65536-byte high-water mark,
// each counting in full, which a write made before the connection does;
// writableNeedDrain stays true until 'drain', and 'drain' fires once the
// buffered bytes are sent. The same holds while a custom lookup is pending,
// writableLength counts a large write the kernel took in part in full,
// untyped code reads the same properties, and a write whose send fails
// after the peer reset the connection answers false. An echo client that
// waits for 'drain' when write answers false moves every byte.
//
// The server picks each connection's handling from `mode` when it accepts
// it. The lookup client's bytes fit in the kernel's buffers, so its 'drain'
// can come before the server accepts that connection; the program waits for
// the accept before it changes `mode`.
import { connect, createServer, Socket } from "node:net";
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from "node:dns";

const CHUNK = 65536;
const TOTAL = 64 * CHUNK;
const chunk = Buffer.alloc(CHUNK, 120);

function untyped(socket: any): string {
  return `${socket.writableLength} ${socket.writableNeedDrain} ${socket.writableHighWaterMark}`;
}

function echo(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const client = connect(port, "127.0.0.1");
    console.log("small write before connect", client.write("hi"), client.writableLength);
    console.log("large write before connect", client.write(Buffer.alloc(70000, 121)), client.writableLength);
    console.log("need drain", client.writableNeedDrain, "untyped", untyped(client));
    let sent = 70002;
    let received = 0;
    const pump = (): void => {
      while (sent < TOTAL) {
        sent += CHUNK;
        if (!client.write(chunk)) {
          client.once("drain", pump);
          return;
        }
      }
      client.end();
    };
    client.once("drain", () => {
      console.log("drain fired, need drain", client.writableNeedDrain, "pending", client.writableLength);
      pump();
    });
    client.on("data", (data: Buffer) => {
      received += data.length;
    });
    client.on("end", () => {
      console.log("received", received, "of", sent);
      resolve();
    });
  });
}

function lookupPending(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const client = connect({
      port,
      host: "localhost",
      lookup: (
        _host: string,
        _options: LookupOneOptions | LookupAllOptions | number | undefined,
        callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
      ) => {
        const answer: LookupAddress[] = [{ address: "127.0.0.1", family: 4 }];
        setTimeout(() => callback(null, answer), 20);
      },
    });
    console.log("lookup write", client.write(Buffer.alloc(70000, 97)));
    console.log("lookup state", client.writableLength, client.writableNeedDrain, "untyped", untyped(client));
    client.once("drain", () => {
      console.log("lookup drain", client.writableLength, client.writableNeedDrain);
      client.destroy();
      resolve();
    });
  });
}

function largeWrite(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const client = connect(port, "127.0.0.1", () => {
      const size = 16 * 1024 * 1024;
      console.log("large write", client.write(Buffer.alloc(size, 98)));
      console.log("large state", client.writableLength === size, client.writableNeedDrain);
      client.once("drain", () => {
        console.log("large drain", client.writableLength, client.writableNeedDrain);
        client.destroy();
        resolve();
      });
      setTimeout(() => {
        if (paused !== null) paused.resume();
      }, 30);
    });
  });
}

function afterReset(port: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const client = connect(port, "127.0.0.1", () => {
      client.pause();
      setTimeout(() => {
        console.log("first write after the peer closed", client.write("a"));
        setTimeout(() => {
          console.log("write after reset", client.write("b"));
        }, 50);
      }, 50);
    });
    client.on("error", () => {});
    client.on("close", () => {
      console.log("closed, destroyed", client.destroyed);
      resolve();
    });
  });
}

let paused: Socket | null = null;
let mode = "echo";
let accepted: (() => void) | null = null;

/** Resolves when the server accepts its next connection. */
function nextConnection(): Promise<void> {
  return new Promise<void>((resolve) => {
    accepted = resolve;
  });
}

const server = createServer((socket: Socket) => {
  if (mode === "echo") socket.pipe(socket);
  else if (mode === "drain") socket.resume();
  else if (mode === "pause") {
    socket.pause();
    paused = socket;
  } else socket.destroy();
  if (accepted !== null) {
    const resolve = accepted;
    accepted = null;
    resolve();
  }
});

server.listen(0, "127.0.0.1", async () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await echo(port);
  mode = "drain";
  const lookupAccepted = nextConnection();
  await lookupPending(port);
  await lookupAccepted;
  mode = "pause";
  await largeWrite(port);
  mode = "end";
  await afterReset(port);
  server.close();
});
