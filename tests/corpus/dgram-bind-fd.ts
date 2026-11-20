// bind({ fd }): Node adopts a datagram descriptor and refuses any other kind
// with ERR_INVALID_FD_TYPE; an fd that is not a positive int32 falls through
// to the ordinary port bind, and bindSync ignores fd entirely.
import * as dgram from "node:dgram";
import { openSync, closeSync } from "node:fs";

const file = openSync("tests/corpus/dgram-bind-fd.ts", "r");
const fileSocket = dgram.createSocket("udp4");
try {
  fileSocket.bind({ fd: file });
  console.log("file fd", "bound");
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  console.log("file fd", String(e.code), e.message);
}
fileSocket.close();
closeSync(file);

for (const fd of [0, -1, 1.5]) {
  const socket = dgram.createSocket("udp4");
  const events: string[] = [];
  socket.on("listening", () => events.push(`listening ${socket.address().port > 0}`));
  socket.bind({ fd: fd as number });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  console.log("fall through", JSON.stringify(fd), events.join(","));
  socket.close();
}

const syncSocket = dgram.createSocket("udp4");
syncSocket.bindSync({ fd: 7, port: 0 });
console.log("bindSync", syncSocket.address().port > 0);
syncSocket.close();

const boundSocket = dgram.createSocket("udp4");
boundSocket.bind({ port: 0 });
const again = openSync("tests/corpus/dgram-bind-fd.ts", "r");
try {
  boundSocket.bind({ fd: again });
  console.log("already bound", "bound");
} catch (err) {
  console.log("already bound", String((err as NodeJS.ErrnoException).code));
}
closeSync(again);
boundSocket.close();
