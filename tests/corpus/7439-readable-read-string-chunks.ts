// A typed read() answers the strings a stream holds: the first value a
// lazy Readable.from pull over a parsed array produces, and the decoded
// text once _read calls setEncoding().
import { Readable } from "node:stream";
const r = Readable.from(JSON.parse('["j1", "j2"]'));
const chunk = r.read();
console.log("first", typeof chunk, chunk === null ? "null" : chunk.toString("hex"));
r.once("readable", () => console.log("later", JSON.stringify(r.read())));
const e = new Readable({
  read() {
    this.setEncoding("utf8");
    this.push(Buffer.from("ab"));
    this.push(null);
  },
});
const text = e.read();
console.log("encoded", typeof text, text === null ? "null" : text.toString("hex"));
