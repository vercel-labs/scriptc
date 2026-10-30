// 'drain' listeners that capture their socket do not keep it after it
// closes: a once('drain') listener still pending when the peer disconnects
// before the buffer drains, and an on('drain') listener on a socket that
// drained and then closed. The sanitized lane's exit audit checks that
// both sockets are freed.
import { connect, createServer, Socket } from "node:net";

function disconnectBeforeDrain(): Promise<void> {
  return new Promise<void>((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.on("error", () => {});
      socket.once("drain", () => console.log("unexpected drain", socket.writableLength));
      console.log("server write", socket.write(Buffer.alloc(16 * 1024 * 1024, 97)));
      socket.on("close", () => {
        console.log("server socket closed, need drain", socket.writableNeedDrain);
        server.close(() => resolve());
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const client = connect(port, "127.0.0.1", () => {
        client.pause();
        setTimeout(() => client.destroy(), 30);
      });
    });
  });
}

function drainThenClose(): Promise<void> {
  return new Promise<void>((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.pause();
      setTimeout(() => socket.resume(), 30);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const client = connect(port, "127.0.0.1", () => {
        let drains = 0;
        client.on("drain", () => {
          drains++;
          console.log("drain", drains, client.writableLength);
          client.end();
        });
        console.log("client write", client.write(Buffer.alloc(16 * 1024 * 1024, 98)));
      });
      client.on("close", () => {
        console.log("client closed");
        server.close(() => resolve());
      });
    });
  });
}

async function main(): Promise<void> {
  await disconnectBeforeDrain();
  await drainThenClose();
  console.log("done");
}

main();
