// The custom dgram resolver's lifecycle: a dynamic send without a callback
// still reaches the peer, a socket closed while its resolver is pending
// ignores the late answer (no send callback, no fresh descriptor), and
// repeated resolved sends complete without retaining anything.
const dgram = require("node:dgram");

const receiver = dgram.createSocket("udp4");
const received = [];
receiver.on("message", (msg) => {
  received.push(msg.toString());
});

const delayLookup = (ms) => (address, family, callback) => {
  setTimeout(() => callback(null, "127.0.0.1"), ms);
};

receiver.bind(0, "127.0.0.1", () => {
  const port = receiver.address().port;

  // 1. a dynamic send with no completion callback
  const noCallback = dgram.createSocket({ type: "udp4", lookup: delayLookup(10) });
  noCallback.send("one", port, "a.test");

  // 2. a socket closed while the resolver is still pending
  const pendingClose = dgram.createSocket({ type: "udp4", lookup: delayLookup(60) });
  pendingClose.send("two", port, "b.test", (error) => {
    console.log("late send callback", error === null ? "ok" : error.code);
  });
  setTimeout(() => {
    console.log("closing with the resolver pending");
    pendingClose.close(() => console.log("closed"));
  }, 20);

  // 3. repeated resolved sends, each completing once
  const repeats = dgram.createSocket({ type: "udp4", lookup: delayLookup(5) });
  let completed = 0;
  for (let i = 0; i < 8; i += 1) {
    repeats.send(`r${i}`, port, "c.test", (error) => {
      if (error !== null) console.log("repeat error", error.code);
      completed += 1;
    });
  }

  setTimeout(() => {
    console.log("completed", completed);
    console.log("received", received.sort().join(","));
    noCallback.close();
    repeats.close();
    receiver.close();
  }, 250);
});
