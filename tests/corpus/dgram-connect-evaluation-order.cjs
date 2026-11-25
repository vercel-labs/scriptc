// The connect arguments run in source order — the socket, the port, the
// host, then the completion callback expression — even when the callback is
// read as an untyped value.
const dgram = require("node:dgram");
const net = require("node:net");

const blocked = new net.BlockList();
blocked.addAddress("127.0.0.1", "ipv4");
const socket = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
socket.on("error", (err) => console.log("error", err.code));
const handlers = { refused: (err) => console.log("callback", err.code) };
const order = [];
function socketOf() {
  order.push("socket");
  return socket;
}
function portOf() {
  order.push("port");
  return 9;
}
function hostOf() {
  order.push("host");
  return "127.0.0.1";
}
function callbackOf() {
  order.push("callback");
  return handlers.refused;
}
socketOf().connect(portOf(), hostOf(), callbackOf());
console.log("order", order.join(","));
setTimeout(() => {
  try {
    socket.close();
  } catch {
    // the refusal path closed it
  }
}, 60);
