// Listeners that read `this`: Node calls a listener with the emitting
// handle as its receiver. The handles here are made by typed entry points
// and never stored in a variable the listeners read, so `this` is the only
// way the functions reach them.
import * as net from "node:net";

const log = [];

const server = net.createServer(function (socket) {
  log.push(`connection receiver is the server ${this === server} ${this.listening}`);
  socket.on("data", function (chunk) {
    log.push(`data receiver ${typeof this.write} ${this === socket} ${String(chunk).trim()}`);
    this.end("pong\n");
  });
  socket.on("close", function () {
    log.push(`close receiver destroyed ${this.destroyed}`);
    server.close();
  });
});

server.on("close", function () {
  log.push(`server close receiver ${this.listening}`);
  for (const line of log) console.log(line);
});

server.listen(0, "127.0.0.1", function () {
  const port = this.address().port;
  log.push(`listening receiver ${typeof port} ${this === server}`);
  const client = net.connect(port, "127.0.0.1", function () {
    log.push(`connect receiver ${this === client}`);
    this.write("ping\n");
  });
  client.on("data", function (chunk) {
    log.push(`client data ${String(chunk).trim()}`);
  });
  client.on("end", function () {
    this.end();
  });
});
