// A falsy completion callback registers nothing: a blocked connect emits
// 'error' as Node's `if (callback)` skip leaves it, and a listener the
// program put on 'connect' itself stays registered.
const dgram = require("node:dgram");
const net = require("node:net");

const blocked = new net.BlockList();
blocked.addAddress("127.0.0.1", "ipv4");
const socket = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
const events = [];
socket.on("connect", () => events.push("connect"));
socket.on("error", (err) => {
  events.push("error " + err.code);
  console.log("refused", events.join(","));
  socket.close();
});
const handlers = { refused: () => events.push("callback") };
socket.connect(9, "127.0.0.1", handlers.absent);
setTimeout(() => {
  try {
    socket.close();
  } catch {
    // the error path closed it already
  }
}, 100);
