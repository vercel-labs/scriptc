// A write the socket's state rejects calls its callback with Node's error
// on the next tick: EPIPE after the peer's FIN, ERR_STREAM_WRITE_AFTER_END
// after end(), and ERR_STREAM_DESTROYED after destroy(). The first two
// destroy a socket that is still open, so 'error' and 'close' follow; a
// destroyed socket emits no 'error'.
"use strict";
const net = require("net");

const describe = (err) => (err ? `${err.constructor.name} ${err.code} ${err.message}` : String(err));
const steps = [];
const log = (line) => steps.push(line);

function afterFin(done) {
  let serverSocket;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    socket.resume();
    socket.on("error", (err) => log(`fin: error ${describe(err)}`));
  });
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1", () => {
      client.on("end", () => {
        const ok = serverSocket.write("late", (err) => {
          log(`fin: callback ${describe(err)}`);
          server.close(done);
        });
        log(`fin: write answered ${ok}`);
      });
      client.end();
    });
  });
}

function afterEnd(done) {
  const server = net.createServer((socket) => {
    socket.on("error", (err) => log(`end: error ${describe(err)}`));
    socket.on("close", (hadError) => {
      log(`end: close ${hadError}`);
      server.close(done);
    });
    socket.end("bye");
    const ok = socket.write("late", (err) => log(`end: callback ${describe(err)}`));
    log(`end: write answered ${ok}`);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1");
    client.on("error", () => {});
    client.resume();
  });
}

function afterDestroy(done) {
  const server = net.createServer((socket) => {
    socket.on("error", (err) => log(`destroy: error ${describe(err)}`));
    socket.on("close", (hadError) => {
      log(`destroy: close ${hadError}`);
      server.close(done);
    });
    socket.destroy();
    const ok = socket.write("late", (err) => log(`destroy: callback ${describe(err)}`));
    log(`destroy: write answered ${ok}`);
  });
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(server.address().port, "127.0.0.1");
    client.on("error", () => {});
    client.resume();
  });
}

afterFin(() =>
  afterEnd(() =>
    afterDestroy(() => {
      for (const step of steps) console.log(step);
    }),
  ),
);
