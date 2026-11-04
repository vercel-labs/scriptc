import { Readable } from "node:stream";

class Holder {
  get name(): "data" {
    return "data";
  }
}
const holder = new Holder();
const rs = new Readable({ read() {} });
rs.on(holder.name, () => console.log("data"));
