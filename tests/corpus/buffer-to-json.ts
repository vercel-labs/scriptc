// Buffer#toJSON and the buffer module's size constants: the
// { type: "Buffer", data } object a Buffer serializes to, the copy its
// data array takes, and the limits the module and its constants object
// publish.
import { Buffer, constants, INSPECT_MAX_BYTES, kMaxLength, kStringMaxLength } from "node:buffer";

const buf = Buffer.from("hi");
const json = buf.toJSON();
console.log(json.type, Array.isArray(json.data), json.data.join(","));
console.log(JSON.stringify(buf), JSON.stringify(buf.toJSON()));
console.log(JSON.stringify(Buffer.from([0, 255, 1])));
console.log(JSON.stringify(Buffer.alloc(0)));
const again = buf.toJSON();
console.log(again.data !== json.data);
again.data[0] = 99;
console.log(buf[0], json.data[0]);
console.log(constants.MAX_LENGTH, constants.MAX_STRING_LENGTH);
console.log(kMaxLength === constants.MAX_LENGTH, kStringMaxLength, INSPECT_MAX_BYTES);
console.log(JSON.stringify({ key: Buffer.from("a") }));
