// A JavaScript message listener passed by name — a function declaration, a
// member reference, or a listener registered with on('message', named) —
// constructs the socket and receives datagrams like an inline one.
const dgram = require("node:dgram");

const received = [];
let expected = 4;
let closed = 0;

function onCreated(msg, rinfo) {
  received.push(`createSocket:${String(msg)}:${rinfo.address}`);
}
function onConstructed(msg) {
  received.push(`new Socket:${String(msg)}`);
}
const handlers = {
  onMessage(msg) {
    received.push(`member:${String(msg)}`);
  },
};
function onRegistered(msg) {
  received.push(`on:${String(msg)}`);
}

function settle() {
  if (received.length < expected) return;
  received.sort();
  for (const line of received) console.log(line);
  process.exitCode = 0;
  for (const socket of sockets) socket.close();
}
function closedOne() {
  closed += 1;
  if (closed === sockets.length) console.log("closed", closed);
}

const created = dgram.createSocket("udp4", onCreated);
const constructed = new dgram.Socket("udp4", onConstructed);
const member = dgram.createSocket("udp4", handlers.onMessage);
const registered = dgram.createSocket("udp4");
registered.on("message", onRegistered);
const sockets = [created, constructed, member, registered];

for (const socket of sockets) {
  socket.on("message", settle);
  socket.on("close", closedOne);
}

function bindAll(index) {
  if (index === sockets.length) {
    const peer = dgram.createSocket("udp4");
    for (const socket of sockets) peer.send("hi", socket.address().port, "127.0.0.1");
    setTimeout(() => peer.close(), 50);
    return;
  }
  sockets[index].bind(0, "127.0.0.1", () => bindAll(index + 1));
}
bindAll(0);
