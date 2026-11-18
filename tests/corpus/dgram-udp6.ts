// udp6 sockets: the family every sockaddr uses, the address record, a
// datagram over ::1, the connect default (::1), the wildcard bind address
// ("::"), ipv6Only, and the address family in rinfo.
import * as dgram from "node:dgram";

await new Promise<void>((resolve) => {
  const socket = dgram.createSocket("udp6");
  socket.on("message", (msg, rinfo) => {
    console.log("message", String(msg), rinfo.family, rinfo.address);
    socket.close();
  });
  socket.on("close", () => resolve());
  socket.bind(0, "::1", () => {
    const address = socket.address();
    console.log("address", address.address, address.family, typeof address.port);
    socket.send("hello", address.port, "::1");
  });
});

await new Promise<void>((resolve) => {
  const socket = dgram.createSocket({ type: "udp6", ipv6Only: true });
  socket.on("close", () => resolve());
  socket.bind(0, () => {
    const address = socket.address();
    console.log("ipv6Only", address.address, address.family, typeof address.port);
    socket.close();
  });
});

// The TTL and multicast knobs set the IPv6 options on a udp6 socket.
await new Promise<void>((resolve) => {
  const socket = dgram.createSocket("udp6");
  socket.on("close", () => resolve());
  socket.bind(0, "::1", () => {
    socket.setBroadcast(true);
    console.log(
      "options",
      socket.setTTL(64),
      socket.setMulticastTTL(2),
      socket.setMulticastLoopback(true),
    );
    socket.close();
  });
});

// A connected udp6 pair, the remoteAddress record, and the connected
// one-argument send.
await new Promise<void>((resolve) => {
  const peer = dgram.createSocket("udp6");
  peer.on("message", (msg) => {
    console.log("peer", String(msg));
    peer.close();
  });
  peer.bind(0, "::1", () => {
    const client = dgram.createSocket("udp6");
    client.connect(peer.address().port, "::1", () => {
      const remote = client.remoteAddress();
      console.log("remote", remote.address, remote.family);
      client.send("v6");
      client.on("close", () => resolve());
      setTimeout(() => client.close(), 20);
    });
  });
});
