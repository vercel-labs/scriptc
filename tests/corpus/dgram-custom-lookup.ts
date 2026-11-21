// createSocket({ lookup }): the program's resolver replaces Node's handle
// lookup for bind, connect and the unconnected sends — it gets the address
// and the socket family, and the operation continues from its answer,
// synchronously when it answers synchronously and later when it does not.
import * as dgram from "node:dgram";

const address4 = "127.0.0.1";

const bindPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const sock = dgram.createSocket({
      type: "udp4",
      lookup: (address, family, callback) => {
        console.log(`bind lookup ${address} ${family}`);
        callback(null, address4);
      },
    });
    sock.on("close", () => resolve());
    sock.bind(0, "bind.test", () => {
      console.log(`bound ${sock.address().address}`);
      sock.close();
    });
  });

const connectPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const sock = dgram.createSocket({
      type: "udp4",
      lookup: (address, family, callback) => {
        console.log(`connect lookup ${address} ${family}`);
        setTimeout(() => callback(null, "127.0.0.2"), 10);
      },
    });
    sock.on("close", () => resolve());
    sock.connect(9, "connect.test", () => {
      console.log(`connected ${sock.remoteAddress().address}`);
      sock.close();
    });
  });

const sendPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const receiver = dgram.createSocket("udp4");
    receiver.on("message", (msg, rinfo) => {
      console.log(`received ${msg.toString()} from ${rinfo.address}`);
      receiver.close();
      resolve();
    });
    receiver.bind(0, "127.0.0.1", () => {
      const sender = dgram.createSocket({
        type: "udp4",
        lookup: (address, family, callback) => {
          console.log(`send lookup ${address} ${family}`);
          callback(null, address4);
        },
      });
      sender.send("hi", receiver.address().port, "send.test", (error) => {
        console.log(`sent ${error === null}`);
        sender.close();
      });
    });
  });

const errorPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const sock = dgram.createSocket({
      type: "udp4",
      lookup: (_address, _family, callback) => {
        callback(new Error("nope"), "");
      },
    });
    sock.on("error", (error: Error) => {
      console.log(`bind error ${error.message}`);
      sock.close();
    });
    sock.on("close", () => resolve());
    sock.bind(0, "127.0.0.1");
  });


const hostlessSendPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const sock = dgram.createSocket({
      type: "udp4",
      lookup: (address, family, callback) => {
        console.log(`self lookup ${address} ${family}`);
        callback(null, address4);
      },
    });
    sock.on("message", (msg) => {
      console.log(`self received ${msg.toString()}`);
      sock.close();
      resolve();
    });
    sock.bind(0, "127.0.0.1", () => {
      sock.send("me", sock.address().port, () => console.log("self sent"));
    });
  });

const hostlessConnectPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const sock = dgram.createSocket({
      type: "udp4",
      lookup: (address, family, callback) => {
        console.log(`hostless connect lookup ${address} ${family}`);
        callback(null, address4);
      },
    });
    sock.on("close", () => resolve());
    sock.connect(9, () => {
      console.log("hostless connected");
      sock.close();
    });
  });

const sendErrorPhase = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const sock = dgram.createSocket({
      type: "udp4",
      lookup: (address, family, callback) => {
        if (address === "t.test") {
          callback(new Error("sendfail"), "");
          return;
        }
        callback(null, address4);
      },
    });
    sock.on("error", (error: Error) => console.log(`send error event ${error.message}`));
    sock.on("close", () => resolve());
    sock.bind(0, "127.0.0.1", () => {
      sock.send("x", 9, "t.test", (error) => {
        console.log(`send error cb ${error === null ? "none" : error.message}`);
        sock.close();
      });
    });
  });

await bindPhase();
await connectPhase();
await sendPhase();
await errorPhase();
await hostlessSendPhase();
await hostlessConnectPhase();
await sendErrorPhase();
