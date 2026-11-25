// A TCP responder that answers a truncated UDP reply with a zero-length frame
// and then streams: the resolver rejects the frame with EBADRESP instead of
// reading the stream into its buffer. The truncated UDP reply moves the query
// to TCP, where the responder writes a zero length prefix followed by far more
// bytes than any DNS message holds.
const dns = require("node:dns");
const { createSocket } = require("node:dgram");
const net = require("node:net");

let active = null;

const udp = createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  if (msg.length < 12) return;
  const head = Buffer.alloc(12);
  msg.copy(head, 0, 0, 2);
  head[2] = 0x83; // QR | TC | RD
  head[3] = 0x00;
  udp.send(head, 0, 12, rinfo.port, rinfo.address);
});

udp.bind(0, "127.0.0.1", () => {
  const port = udp.address().port;
  const tcp = net.createServer((sock) => {
    active = sock;
    let got = 0;
    let streaming = false;
    sock.on("data", (data) => {
      got += data.length;
      if (got < 2 || streaming) return;
      streaming = true;
      sock.write(Buffer.from([0, 0]));
      sock.write(Buffer.alloc(64 * 1024, 0x41));
    });
    sock.on("error", () => {});
  });
  tcp.listen(port, "127.0.0.1", () => {
    const resolver = new dns.Resolver({ timeout: 300, tries: 1 });
    resolver.setServers([`127.0.0.1:${port}`]);
    resolver.resolve4("zero-frame.test", (err) => {
      console.log(
        "zero frame",
        JSON.stringify({
          name: err && err.name,
          code: err && err.code,
          syscall: err && err.syscall,
          hostname: err && err.hostname,
          message: err && err.message,
        }),
      );
      if (active !== null) active.destroy();
      tcp.close();
      udp.close();
      console.log("done");
    });
  });
});
