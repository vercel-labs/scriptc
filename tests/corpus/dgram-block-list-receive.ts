// receiveBlockList: a datagram from a blocked address is dropped, one from
// any other address is delivered.
import * as dgram from "node:dgram";
import * as net from "node:net";

async function deliver(blocked: string): Promise<void> {
  const receive = new net.BlockList();
  receive.addAddress(blocked, "ipv4");
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true, receiveBlockList: receive });
  socket.bindSync({ port: 0, address: "127.0.0.1" });
  const messages: string[] = [];
  socket.on("message", (msg) => messages.push(String(msg)));
  const peer = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => peer.bind(0, "127.0.0.1", resolve));
  peer.send("hello", socket.address().port, "127.0.0.1");
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  console.log(blocked, messages.join(","));
  socket.close();
  peer.close();
}

await deliver("10.9.9.9");
await deliver("127.0.0.1");
