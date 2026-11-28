// Many short-lived h2 servers whose timeout callbacks capture the server: a
// settled server releases its timeout listeners, so the captures form no
// refcount cycle and every closed server is reclaimed (the sanitized lane's
// RC audit is the check; the output is the same under Node). No top-level
// await, so the sanitized lane can compile it too.
import * as http2 from "node:http2";

const ROUNDS = 200;
let done = 0;

const step = (): void => {
  if (done === ROUNDS) {
    console.log("servers", ROUNDS);
    return;
  }
  const server = http2.createServer();
  let open = true;
  server.setTimeout(1000, () => {
    // the callback captures its server
    if (open) server.close();
  });
  server.listen(0, "127.0.0.1", () => {
    server.close(() => {
      open = false;
      done += 1;
      step();
    });
  });
};

step();
