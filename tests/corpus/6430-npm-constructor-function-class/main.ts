// Constructing a CommonJS constructor-function "class" imported by a named
// member alias (`exports = module.exports = Client; exports.StatsD =
// Client`) through a re-exporting package index: prototype methods, a child
// client linked with util.inherits, and a callback-style close.
import { StatsD } from "metrics-client";

const client = new StatsD({ prefix: "app." });
client.onSent((line: string) => console.log("event", line));
console.log(client.increment("boot"));
console.log(client.gauge("heap", 42));
console.log(typeof client.increment, typeof client.onSent);
const child = client.childClient({ prefix: "db." });
console.log(child.increment("query", 3));
console.log(child.gauge("pool", 1), child.sent.length, client.sent.length);
const bare = new StatsD();
console.log(bare.increment("x"), bare.sent.length);
client.close((error: Error | null, count: number) => {
  console.log("closed", error, count);
});
