// sendBlockList edges: a blocked connect fails before it connects but
// leaves the socket bound, connectSync throws the same error, a blocked
// send with no callback answers nothing, and a connected socket's send is
// never gated (Node checks only a non-connected send's looked-up address).
import * as dgram from "node:dgram";
import * as net from "node:net";

const blocked = new net.BlockList();
blocked.addAddress("127.0.0.1", "ipv4");

// connect() without a callback: the deferred 'error' event carries
// ERR_IP_BLOCKED, 'connect' never fires, and the implicit bind stands.
const emitter = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
let connected = false;
emitter.on("connect", () => {
  connected = true;
});
const code = await new Promise<string>((resolve) => {
  emitter.once("error", (err) => {
    resolve((err as NodeJS.ErrnoException).code ?? err.message);
  });
  emitter.connect(9, "127.0.0.1");
});
console.log("connect error", code, "connect fired", connected);
console.log("bound after connect", emitter.address().port > 0);
emitter.close();

// connect() with a callback: Node answers the callback (not 'error') and
// still never connects.
const withCallback = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
let callbackRan = false;
let callbackConnect = false;
withCallback.on("connect", () => {
  callbackConnect = true;
});
await new Promise<void>((resolve) => {
  withCallback.connect(9, "127.0.0.1", () => {
    callbackRan = true;
    resolve();
  });
});
console.log("callback ran", callbackRan, "connect fired", callbackConnect);
withCallback.close();

// connectSync() throws the error and leaves the socket bound.
const sync = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
try {
  sync.connectSync(9, "127.0.0.1");
  console.log("connectSync ok");
} catch (err) {
  console.log("connectSync", (err as NodeJS.ErrnoException).code, "bound", sync.address().port > 0);
}
sync.close();

// A blocked send with no callback reaches nothing and answers nothing.
const quiet = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
quiet.bindSync({ port: 0, address: "127.0.0.1" });
quiet.send("dropped", 9, "127.0.0.1");
console.log("quiet send returned");
await new Promise<void>((resolve) => setTimeout(resolve, 40));
quiet.close();

// A connected send carries no address, so a list that grew after the
// connect does not gate it.
const peer = dgram.createSocket("udp4");
const received: string[] = [];
peer.on("message", (msg) => received.push(String(msg)));
await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));
const late = new net.BlockList();
const dialed = dgram.createSocket({ type: "udp4", sendBlockList: late });
await new Promise<void>((resolve) => dialed.connect(peer.address().port, "127.0.0.1", resolve));
late.addAddress("127.0.0.1", "ipv4");
const answer = await new Promise<string>((resolve) => {
  dialed.send("connected", (err: Error | null) => {
    resolve(err ? ((err as NodeJS.ErrnoException).code ?? err.message) : "sent");
  });
});
console.log("connected send", answer);
await new Promise<void>((resolve) => setTimeout(resolve, 40));
console.log("peer", received.join(","));
dialed.close();
peer.close();
