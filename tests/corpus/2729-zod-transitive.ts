// @dynamic
import { z } from "zod";

const Schema = z.object({ name: z.string() });
const a = Schema.parse({ name: "hi" });
console.log(a.name);
const b = Schema.parse({ name: "test" });
console.log(b.name);
console.log("ok");
