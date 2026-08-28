import * as http from "node:http";

const server = http.createServer((_req, res) => {
  const extension = _req.url === "/extension";
  res.writeHead(200, {
    "content-type": "text/plain",
    "transfer-encoding": extension ? "xchunked" : "chunked",
  });
  res.write("hello ");
  res.end("world");
  if (extension) server.close(() => console.log("server closed"));
});

server.listen(0, () => {
  console.log("listening");
  process.stderr.write(`PORT ${server.address().port}\n`);
});
