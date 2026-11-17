// A blocked connect, connectSync or send still leaves the socket genuinely
// bound: the implicit bind is a kernel bind, so 'listening' carries an
// ephemeral port and a datagram sent to it arrives.
import * as dgram from "node:dgram";
import * as net from "node:net";

const blocked = new net.BlockList();
blocked.addAddress("127.0.0.1", "ipv4");
const peer = dgram.createSocket("udp4");
const received: string[] = [];
peer.on("message", (msg) => received.push(String(msg)));
await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));

const connector = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
const connectorEvents: string[] = [];
let connectorPort = 0;
connector.on("listening", () => {
  connectorPort = connector.address().port;
  connectorEvents.push(`listening ${connectorPort > 0}`);
});
connector.on("message", (msg) => connectorEvents.push(`message ${String(msg)}`));
await new Promise<void>((resolve) => {
  connector.once("error", () => resolve());
  connector.connect(9, "127.0.0.1");
});
peer.send("to connector", connectorPort, "127.0.0.1");
await new Promise<void>((resolve) => setTimeout(resolve, 40));
console.log("connect", connectorEvents.join(","));
connector.close();

const sync = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
const syncEvents: string[] = [];
let syncPort = 0;
sync.on("listening", () => {
  syncPort = sync.address().port;
  syncEvents.push(`listening ${syncPort > 0}`);
});
sync.on("message", (msg) => syncEvents.push(`message ${String(msg)}`));
try {
  sync.connectSync(9, "127.0.0.1");
} catch (err) {
  syncEvents.push(String((err as NodeJS.ErrnoException).code));
}
syncPort = sync.address().port;
peer.send("to sync", syncPort, "127.0.0.1");
await new Promise<void>((resolve) => setTimeout(resolve, 40));
console.log("connectSync", syncEvents.join(","));
sync.close();

const quiet = dgram.createSocket({ type: "udp4", sendBlockList: blocked });
const quietEvents: string[] = [];
let quietPort = 0;
quiet.on("listening", () => {
  quietPort = quiet.address().port;
  quietEvents.push(`listening ${quietPort > 0}`);
});
quiet.on("message", (msg) => quietEvents.push(`message ${String(msg)}`));
quiet.send("dropped", 9, "127.0.0.1");
await new Promise<void>((resolve) => setTimeout(resolve, 40));
peer.send("to quiet", quietPort, "127.0.0.1");
await new Promise<void>((resolve) => setTimeout(resolve, 40));
console.log("send", quietEvents.join(","));
quiet.close();
peer.close();
