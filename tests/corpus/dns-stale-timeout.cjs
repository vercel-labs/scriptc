// A responder that closes its TCP connection while holding the event loop past
// the query's deadline: the close and the query's expired timer arrive in the
// same drain. The program only reports that the query settled, so Node and the
// compiled program print the same whatever the outcome; what this pins is that
// the stale timer is not delivered as a socket.
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
    let started = false;
    sock.on("data", (data) => {
      got += data.length;
      if (got < 2 || started) return;
      started = true;
      // Hold the loop well past the resolver's 20 ms deadline, then close, so
      // the close and the expired timer are both pending when it resumes.
      const until = Date.now() + 80;
      while (Date.now() < until) {
        // spin
      }
      sock.destroy();
    });
    sock.on("error", () => {});
  });
  tcp.listen(port, "127.0.0.1", () => {
    const resolver = new dns.Resolver({ timeout: 20, tries: 1 });
    resolver.setServers([`127.0.0.1:${port}`]);
    resolver.resolve4("stale.test", (err) => {
      console.log("settled", err === null ? "ok" : "error");
      if (active !== null) active.destroy();
      tcp.close();
      udp.close();
      console.log("done");
    });
  });
});
