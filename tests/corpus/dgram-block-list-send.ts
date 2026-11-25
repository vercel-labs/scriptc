// sendBlockList: a blocked destination answers the send callback with
// ERR_IP_BLOCKED, one from any other address sends normally.
import * as dgram from "node:dgram";
import * as net from "node:net";

const peer = dgram.createSocket("udp4");
const received: string[] = [];
peer.on("message", (msg) => received.push(String(msg)));
await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));
const peerPort = peer.address().port;

async function sendTo(blocked: string): Promise<void> {
  const sendList = new net.BlockList();
  sendList.addAddress(blocked, "ipv4");
  const socket = dgram.createSocket({ type: "udp4", sendBlockList: sendList });
  socket.bindSync({ port: 0, address: "127.0.0.1" });
  const answer = await new Promise<string>((resolve) => {
    socket.send("payload", peerPort, "127.0.0.1", (err: Error | null) => {
      resolve(err ? (err as NodeJS.ErrnoException).code ?? err.message : "sent");
    });
  });
  console.log(blocked, answer);
  socket.close();
}

await sendTo("10.9.9.9");
await sendTo("127.0.0.1");
await new Promise<void>((resolve) => setTimeout(resolve, 40));
console.log("peer", received.join(","));
peer.close();
