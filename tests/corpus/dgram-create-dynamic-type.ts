// A `string`-typed socket type: the call compiles and the runtime answers
// Node's ERR_SOCKET_BAD_TYPE for a value that is not udp4 or udp6.
import * as dgram from "node:dgram";

const valid: string = "udp4";
const socket = dgram.createSocket(valid);
console.log("typed", socket.type);
socket.close();

const invalid: string = "udp9";
try {
  dgram.createSocket(invalid);
} catch (err) {
  console.log("typed", (err as NodeJS.ErrnoException).code);
}
