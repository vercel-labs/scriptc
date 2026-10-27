// The hot-shots StatsD client (compiled from scriptc's built-in shim) when a
// send fails: with a callback or an errorHandler the error goes there; with
// neither, the client logs it and emits it on the socket, where an 'error'
// event nobody listens for ends the process with status 1.
import { StatsD } from "hot-shots";

// A datagram larger than udp allows fails with EMSGSIZE before it leaves
// the host; port 9 keeps the message the same on every run.
const big = "x".repeat(70000);

const withCallback = new StatsD({ host: "127.0.0.1", port: 9 });
withCallback.increment(big, 1, 1, [], (err: Error | null | undefined) => {
  console.log("callback:", err ? err.message : "no error");
  withCallback.close();

  const withHandler = new StatsD({
    host: "127.0.0.1",
    port: 9,
    errorHandler: (error: Error) => {
      console.log("errorHandler:", error.message);
      withHandler.close();
      console.log("without a callback or errorHandler");
      new StatsD({ host: "127.0.0.1", port: 9 }).increment(big);
    },
  });
  withHandler.increment(big);
});
