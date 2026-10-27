// http.RequestOptions as a declared type: a checked-dynamic option record.
import type http from "node:http";
const socket = process.env.NO_SUCH_SOCKET_VAR;
const base: http.RequestOptions = socket ? { socketPath: socket } : { host: "127.0.0.1", port: 8080 };
const full: http.RequestOptions = { ...base, path: "/x", method: "POST", headers: { "x-a": "1" } };
console.log(JSON.stringify(base), JSON.stringify(full));
function describe(o: http.RequestOptions): string {
  return `${String(o.host)}:${String(o.port)}${String(o.path ?? "/")}`;
}
console.log(describe(full), describe({ host: "h" }));
