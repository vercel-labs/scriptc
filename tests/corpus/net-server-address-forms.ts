// server.address(): the AddressInfo record a TCP listener answers (IPv4 and
// IPv6), and its port after listen.
import * as net from "node:net";

await new Promise<void>((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as net.AddressInfo;
    console.log("ipv4", address.address, address.family, address.port > 0);
    server.close(() => resolve());
  });
});

await new Promise<void>((resolve) => {
  const server = net.createServer();
  server.listen(0, "::1", () => {
    const address = server.address() as net.AddressInfo;
    console.log("ipv6", address.address, address.family, address.port > 0);
    server.close(() => resolve());
  });
});
