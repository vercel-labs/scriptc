// dgram's class surface under @types/node: instanceof, the type property,
// udp6, the message-listener form, bind()/bind(options), remoteAddress,
// source-specific membership and [Symbol.asyncDispose].
import * as dgram from "node:dgram";

function attempt(label: string, op: () => unknown): void {
  try {
    op();
    console.log(label, "ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const v6 = dgram.createSocket("udp6");
console.log("udp6", v6 instanceof dgram.Socket);
v6.close();

await new Promise<void>((resolve) => {
  const socket = dgram.createSocket("udp4", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    console.log("listener", msg.toString(), rinfo.family);
    socket.close();
  });
  socket.on("close", () => resolve());
  socket.bind({ port: 0, address: "127.0.0.1" }, () => {
    socket.send("ping", socket.address().port, "127.0.0.1");
  });
});

await new Promise<void>((resolve) => {
  const peer = dgram.createSocket("udp4");
  peer.on("message", (msg: Buffer) => {
    console.log("peer", msg.toString());
    peer.close();
  });
  peer.bind(0, "127.0.0.1", () => {
    const client = dgram.createSocket("udp4");
    client.connect(peer.address().port, "127.0.0.1", () => {
      const remote = client.remoteAddress();
      console.log("remote", remote.address, remote.family, remote.port === peer.address().port);
      client.send("hello");
      setTimeout(() => {
        client[Symbol.asyncDispose]().then(() => {
          console.log("disposed");
          resolve();
        });
      }, 20);
    });
  });
});

const group = dgram.createSocket("udp4");
group.bind(0, "127.0.0.1", () => {
  attempt("ssm add", () =>
    group.addSourceSpecificMembership("127.0.0.1", "232.0.0.1", "127.0.0.1"),
  );
  attempt("ssm drop", () =>
    group.dropSourceSpecificMembership("127.0.0.1", "232.0.0.1", "127.0.0.1"),
  );
  group.close();
});
