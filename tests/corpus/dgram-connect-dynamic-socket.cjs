// A checked-dynamic socket's connect answers its completion callback the way
// the typed form does: a blocked destination reports ERR_IP_BLOCKED to that
// callback (no 'error' event is needed), and a permitted one connects.
const dgram = require("node:dgram");
const net = require("node:net");

const blocked = new net.BlockList();
blocked.addAddress("127.0.0.1", "ipv4");
const peer = dgram.createSocket("udp4");
peer.on("message", () => {});
peer.bind(0, "127.0.0.1", () => {
  const handlers = {
    refused: (err) => {
      console.log("refused", err.code);
      const plain = { client: dgram.createSocket("udp4") };
      plain.client.connect(peer.address().port, "127.0.0.1", handlers.connected);
      setTimeout(() => plain.client.close(), 60);
    },
    connected: () => console.log("connected"),
  };
  const stopped = { client: dgram.createSocket({ type: "udp4", sendBlockList: blocked }) };
  stopped.client.connect(9, "127.0.0.1", handlers.refused);
  setTimeout(() => {
    try {
      stopped.client.close();
    } catch {
      // the refusal path closed it
    }
  }, 120);
});
setTimeout(() => peer.close(), 200);
