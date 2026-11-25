// An untyped JavaScript message listener passed to createSocket() or
// new dgram.Socket() registers as on('message'), the way Node's constructor
// attaches it.
const dgram = require("node:dgram");

const first = dgram.createSocket("udp4", (msg, rinfo) => {
  console.log("createSocket listener", String(msg), rinfo.family);
  first.close();
});
first.on("close", () => {
  const second = new dgram.Socket("udp4", (msg) => {
    console.log("Socket listener", String(msg));
    second.close();
  });
  second.on("close", () => console.log("second closed"));
  second.bind(0, "127.0.0.1", () => second.send("two", second.address().port, "127.0.0.1"));
});
first.bind(0, "127.0.0.1", () => first.send("one", first.address().port, "127.0.0.1"));
