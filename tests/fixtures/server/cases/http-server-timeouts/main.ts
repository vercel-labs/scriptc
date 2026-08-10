import { createServer } from "node:http";
const server = createServer((_req, res) => {
  res.end("timeout-configured");
  server.close();
});
server.timeout = 25;
server.headersTimeout = 50;
server.keepAliveTimeout = 75;
server.requestTimeout = 100;
server.listen(0, () => process.stderr.write(`PORT ${server.address().port}\n`));
