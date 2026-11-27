// net.createServer({ blockList }): an options value that is an array
// carries the same blockList (Node reads the property off any object), and
// a blocked address is dropped before 'connection' just as the plain
// object form is. A value without a list still accepts the connection.
import * as net from "node:net";

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);

const blocked = new net.BlockList();
blocked.addAddress("127.0.0.1", "ipv4");

const probe = (label: string, options: net.ServerOpts, next: () => void): void => {
  const server = net.createServer(options, (socket) => {
    say(label, "connection");
    socket.on("error", () => {});
    socket.destroy();
  });
  server.on("error", (err) => say(label, "server error", codeOf(err)));
  server.listen(0, "127.0.0.1", () => {
    const client = net.connect((server.address() as { port: number }).port, "127.0.0.1");
    client.on("connect", () => say(label, "client connect"));
    client.on("data", () => {});
    client.on("error", (err) => say(label, "client error", codeOf(err)));
    client.on("close", () => {
      say(label, "client close");
      server.close(() => {
        say(label, "server closed");
        next();
      });
    });
  });
};

const plain: net.ServerOpts = { blockList: blocked };
const array: net.ServerOpts = [] as unknown as net.ServerOpts;
(array as { blockList?: net.BlockList }).blockList = blocked;

probe("plain", plain, () => {
  probe("array", array, () => {
    probe("open", {}, () => console.log(out.join("\n")));
  });
});
