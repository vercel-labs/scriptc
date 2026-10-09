/* Large bodies through the coalesced head+body write: end(data) with a
 * multi-megabyte body (Content-Length framing) and multi-megabyte chunked
 * writes overflow the socket buffer, so the send is partial and the unsent
 * tail of the head/body/framing slices must buffer in order. The driver
 * reads slowly over raw keep-alive sockets and checks framing, length, and
 * a digest of every body. */
import { createServer } from "node:http";

const parts: string[] = [];
for (let i = 0; i < 120000; i++) parts.push("line " + i + " of the large body\n");
const big = parts.join("");

const server = createServer((req, res) => {
  if (req.url === "/end") {
    res.setHeader("content-type", "text/plain");
    res.end(big);
  } else if (req.url === "/write") {
    res.setHeader("content-type", "text/plain");
    res.write(big);
    res.write(big.slice(0, 1000));
    res.end("tail\n");
  } else if (req.url === "/small") {
    res.statusCode = 201;
    res.setHeader("x-small", "yes");
    res.end("small body");
  } else {
    res.end("bye");
    server.close(() => console.log("server closed"));
  }
});

server.listen(0, () => {
  console.log("listening body=" + big.length);
  process.stderr.write(`PORT ${server.address().port}\n`);
});
