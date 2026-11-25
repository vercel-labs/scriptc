// dgram's synchronous members and the Socket constructor, from a
// JavaScript source: bindSync's address answer and argument ladder,
// connectSync against a live peer, disconnect, remoteAddress, and
// socket[Symbol.asyncDispose].
import dgram from "node:dgram";

function attempt(label, op) {
  try {
    const value = op();
    console.log(label, "ok", value === undefined ? "undefined" : typeof value);
  } catch (e) {
    console.log(label, "throws", e.name, e.code, e.message);
  }
}

const s = new dgram.Socket("udp4");
console.log("new Socket", s instanceof dgram.Socket, s.type);
const info = s.bindSync({ port: 0, address: "127.0.0.1" });
console.log("bindSync", info.address, info.family, typeof info.port);
attempt("rebind sync", () => s.bindSync());
attempt("rebind async", () => s.bind(0));
s.close();

const t = new dgram.Socket({ type: "udp4" });
t.bindSync();
console.log("wildcard", t.address().address, t.address().family, typeof t.address().port);
t.close();

attempt("bindSync number", () => dgram.createSocket("udp4").bindSync(0));
attempt("bindSync bad port", () => dgram.createSocket("udp4").bindSync({ port: 70000 }));
attempt("bindSync hostname", () =>
  dgram.createSocket("udp4").bindSync({ port: 0, address: "localhost" }),
);
attempt("connectSync zero", () => dgram.createSocket("udp4").connectSync(0));

// A connected pair: connectSync records the peer at once, so
// remoteAddress and disconnect work before 'connect' has been emitted.
await new Promise((resolve) => {
  const peer = dgram.createSocket("udp4");
  peer.on("message", (msg) => {
    console.log("peer got", String(msg));
    peer.close();
  });
  peer.bind(0, "127.0.0.1", () => {
    const client = dgram.createSocket("udp4");
    const port = peer.address().port;
    client.connectSync(port, "127.0.0.1");
    const remote = client.remoteAddress();
    console.log("remote", remote.address, remote.family, remote.port === port);
    client.send("hello");
    client.on("close", () => resolve());
    setTimeout(() => {
      client.disconnect();
      console.log("disconnected");
      attempt("remote after disconnect", () => client.remoteAddress());
      client.close();
    }, 20);
  });
});

// socket[Symbol.asyncDispose]() closes through the promise.
await new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  socket.on("close", () => {
    console.log("dispose closed");
    resolve();
  });
  socket.bind(0, "127.0.0.1", () => {
    socket[Symbol.asyncDispose]().then(() => console.log("disposed"));
  });
});
