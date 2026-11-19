// A zero highWaterMark readable whose _read pushes twice synchronously still
// answers one web chunk per push (Node's toWeb enqueues each 'data' chunk).
import { Readable } from "node:stream";

const readable = new Readable({
  read() {
    this.push("pq");
    this.push("r");
    this.push(null);
  },
  highWaterMark: 0,
});
const reader = Readable.toWeb(readable).getReader();
for (let i = 0; i < 3; i++) {
  const result = await reader.read();
  console.log(`read ${i} done ${result.done} ${result.done ? "-" : String(result.value)}`);
  if (result.done) break;
}
