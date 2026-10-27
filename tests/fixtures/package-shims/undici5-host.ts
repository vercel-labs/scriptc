// A Host header value with CR or LF, through the undici 5.x profile: it
// throws before the request is written, as undici 5.29 does (5.12, the
// vendored fixture version, writes the value into the request head).
import * as http from "node:http";
import { Agent, errors, request } from "undici";

const server = http.createServer((_req, res) => {
  res.statusCode = 204;
  res.end();
});
server.listen(0, "127.0.0.1", async () => {
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dispatcher = new Agent();
  for (const host of ["ok.test", "a\r\nX-Injected: 1", "a\nb"]) {
    try {
      const res = await request(`${origin}/`, { dispatcher, headers: { host } });
      await res.body.dump();
      console.log(JSON.stringify(host), res.statusCode);
    } catch (err) {
      if (err instanceof errors.UndiciError) console.log(JSON.stringify(host), err.name, err.code, err.message);
      else throw err;
    }
  }
  await dispatcher.close();
  server.close();
});
