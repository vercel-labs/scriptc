// A transport chosen inside a module-level loop: each pass has its own
// binding, and a callback that runs after the loop keeps the choice of the
// pass that made it.
import * as http from "node:http";
import * as https from "node:https";

const out: string[] = [];
for (const secure of [true, false]) {
  const base = new URL(secure ? "https://127.0.0.1:1/" : "http://127.0.0.1:1/");
  const transport = base.protocol === "https:" ? https.request : http.request;
  // Both callbacks run after the loop. An options object naming another
  // protocol reports which client handled the call, without opening a
  // connection.
  setTimeout(() => {
    try {
      const req = transport({ protocol: "ftp:", hostname: "127.0.0.1", port: 1, path: "/" });
      out.push("no throw");
      req.on("error", () => {});
      req.end();
    } catch (err) {
      out.push(String(err));
    }
    if (out.length === 2) console.log("loop:", out.join(" | "));
  }, 20);
}
