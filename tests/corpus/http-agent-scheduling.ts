// agent.scheduling: 'lifo' (Node's default), a plain settable property that
// keeps any assigned value, 'fifo' through the constructor option, the same
// default on https.Agent, and the constructor's ERR_INVALID_ARG_VALUE for
// any other value.
import * as http from "node:http";
import * as https from "node:https";

const a = new http.Agent();
console.log("default", a.scheduling, a.keepAlive, a.protocol);
a.scheduling = "fifo";
console.log("set fifo", a.scheduling);
a.scheduling = "lifo";
console.log("set lifo", a.scheduling);
(a as unknown as { scheduling: unknown }).scheduling = 5;
console.log("set 5", JSON.stringify((a as unknown as { scheduling: unknown }).scheduling));

const b = new http.Agent({ keepAlive: true, scheduling: "fifo" });
console.log("constructed", b.scheduling, b.keepAlive);
const c = new https.Agent({ scheduling: "fifo" });
console.log("https", c.scheduling, c.protocol);

const bad: string = "wat";
try {
  new http.Agent({ scheduling: bad as "fifo" });
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  console.log("invalid", e.code, e.message);
}
