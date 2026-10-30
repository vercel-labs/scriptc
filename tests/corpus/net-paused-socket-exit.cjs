// A connected socket that is paused and has nothing to write does not
// keep the process alive: with the server and its connection unref'd,
// the process exits before the unref'd timer would fire.
"use strict";
const net = require("net");

net
  .createServer((connection) => {
    connection.unref();
  })
  .listen(0, "127.0.0.1", function () {
    const client = net.connect(this.address().port, "127.0.0.1");
    client.on("connect", () => {
      console.log("connected");
      client.pause();
    });
    setTimeout(() => {
      console.log("timer fired");
      process.exit(1);
    }, 2000).unref();
  })
  .unref();

process.on("exit", (code) => console.log("exit", code));
