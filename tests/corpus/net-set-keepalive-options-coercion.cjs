// setKeepAlive(options) reads enable, initialDelay, interval and count before
// it converts any of them. The initialDelay conversion calls its valueOf,
// which removes the interval property here; the interval value the read
// already took still converts and tunes the probes.
const net = require("node:net");

const server = net.createServer((conn) => conn.on("error", () => {}));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const client = net.connect(port, "127.0.0.1");
  client.on("error", () => {});
  client.on("connect", () => {
    const options = {
      enable: true,
      initialDelay: {
        valueOf() {
          delete options.interval;
          return 1000;
        },
      },
      interval: {
        valueOf() {
          console.log("interval converted");
          return 2000;
        },
      },
    };
    client.setKeepAlive(options);
    console.log("set", "interval" in options === false);
    client.on("close", () => server.close(() => console.log("closed")));
    client.destroy();
  });
});
