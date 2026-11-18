// send's list payload and the callback forms without an address, from a
// typed source: the bundled declarations now describe Node's ladder.
import * as dgram from "node:dgram";

const peer = dgram.createSocket("udp4");
const chunks: Buffer[] = [];
peer.on("message", (msg) => chunks.push(Buffer.from(msg)));
await new Promise<void>((resolve) => {
  peer.bind(0, "127.0.0.1", () => {
    const sender = dgram.createSocket("udp4");
    sender.send(
      [Buffer.from("ab"), Buffer.from("cd")],
      peer.address().port,
      "127.0.0.1",
      (err, bytes) => {
        console.log("list sent", err, bytes);
        sender.close();
      },
    );
    setTimeout(() => {
      console.log("peer got", Buffer.concat(chunks).toString());
      peer.close();
      resolve();
    }, 20);
  });
});

// A connected socket's callback form: send(msg, callback) sends to the peer.
await new Promise<void>((resolve) => {
  const receiver = dgram.createSocket("udp4");
  receiver.on("message", (msg) => {
    console.log("connected got", String(msg));
    receiver.close();
    resolve();
  });
  receiver.bind(0, "127.0.0.1", () => {
    const client = dgram.createSocket("udp4");
    client.connect(receiver.address().port, "127.0.0.1", () => {
      client.send("hi", (err, bytes) => {
        console.log("connected sent", err, bytes);
        client.close();
      });
    });
  });
});
