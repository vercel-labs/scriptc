// The TypeScript twin of compat-net-socket-members.mjs: net members the
// server and socket programs do not reach, from a typed source. BlockList
// rules and size, SocketAddress fields, socket.pending and the local and
// remote family, the 'ready', 'timeout' and 'drain' events,
// destroySoon() and resetAndDestroy(), and a server's 'error' for a port
// in use. Each section closes its server before the next starts.
import * as net from "node:net";

const blockList = new net.BlockList();
blockList.addAddress("1.2.3.4");
blockList.addSubnet("10.0.0.0", 8);
console.log(JSON.stringify(blockList.rules), blockList.size, blockList.check("10.1.1.1"), blockList.check("9.1.1.1"));

const address = new net.SocketAddress({ address: "127.0.0.1", port: 80 });
console.log(address.address, address.family, address.flowlabel, address.port);

/** An echo server on a loopback port. */
function echoServer(): net.Server {
  return net.createServer((socket) => {
    socket.on("data", (chunk) => {
      socket.write(chunk);
    });
    socket.on("error", () => {});
  });
}
const portOf = (server: net.Server): number => (server.address() as net.AddressInfo).port;

// pending, 'ready', and the address families once connected.
await new Promise<void>((resolve) => {
  const server = echoServer();
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(portOf(server), "127.0.0.1");
    console.log("pending", client.pending);
    client.on("ready", () => {
      console.log("ready");
      client.destroy();
    });
    client.on("connect", () => console.log("connect", client.pending, client.localAddress, client.localFamily, client.remoteFamily));
    client.on("close", () => {
      server.close(() => resolve());
    });
  });
});

// 'timeout' after an idle period.
await new Promise<void>((resolve) => {
  const server = echoServer();
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(portOf(server), "127.0.0.1");
    client.setTimeout(20);
    client.on("timeout", () => {
      console.log("timeout");
      client.destroy();
    });
    client.on("close", () => {
      server.close(() => resolve());
    });
  });
});

// 'drain' after a write the kernel buffer cannot take at once.
await new Promise<void>((resolve) => {
  const server = echoServer();
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(portOf(server), "127.0.0.1");
    client.on("connect", () => {
      const accepted = client.write(Buffer.alloc(4 << 20));
      client.on("drain", () => {
        console.log("drain", accepted);
        client.destroy();
      });
    });
    client.on("error", () => {});
    client.on("close", () => {
      server.close(() => resolve());
    });
  });
});

// destroySoon() ends after the pending write; resetAndDestroy() returns the socket.
await new Promise<void>((resolve) => {
  const server = echoServer();
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(portOf(server), "127.0.0.1");
    client.on("connect", () => {
      client.write("x");
      client.destroySoon();
    });
    client.on("close", () => {
      console.log("destroySoon closed", client.destroyed);
      server.close(() => resolve());
    });
  });
});
await new Promise<void>((resolve) => {
  const server = echoServer();
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect(portOf(server), "127.0.0.1");
    client.on("connect", () => console.log(client.resetAndDestroy() === client));
    client.on("close", () => {
      console.log("reset closed", client.destroyed);
      server.close(() => resolve());
    });
  });
});

// A second server on a port in use reports EADDRINUSE through 'error'.
await new Promise<void>((resolve) => {
  const first = net.createServer();
  first.listen(0, "127.0.0.1", () => {
    const second = net.createServer();
    second.on("error", (error: NodeJS.ErrnoException) => {
      console.log("error", error.code, error.syscall);
      first.close(() => resolve());
    });
    second.listen(portOf(first), "127.0.0.1");
  });
});
