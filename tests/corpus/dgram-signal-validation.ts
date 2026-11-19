// createSocket's signal option validates like Node's validateAbortSignal
// (`'aborted' in signal`), and installing the listener on a value that only
// looks like a signal fails with Node's TypeError; an already-aborted signal
// closes the socket inside the constructor.
import * as dgram from "node:dgram";

const signals: unknown[] = [{}, { aborted: false }, { aborted: 1 }, 5, null];
for (const signal of signals) {
  try {
    const socket = dgram.createSocket({ type: "udp4", signal: signal as AbortSignal });
    console.log(JSON.stringify(signal), "created");
    try {
      socket.close();
    } catch (err) {
      console.log(JSON.stringify(signal), String((err as NodeJS.ErrnoException).code));
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log(JSON.stringify(signal), String(e.code), e.message);
  }
}
