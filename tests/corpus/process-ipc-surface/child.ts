// The forked child's side of process.send: the channel starts connected,
// a reply send answers through its callback with a null error, disconnect()
// clears process.connected, and a later send still answers false and
// reports ERR_IPC_CHANNEL_CLOSED through the callback.
process.once("message", (message: { kind: string }) => {
  console.log("child message", message.kind, process.connected, typeof process.send);
  process.send?.({ connected: process.connected, echo: message.kind }, (error: Error | null) => {
    console.log("sent", error === null);
    process.disconnect?.();
    console.log("afterDisconnect", process.connected);
    const queued = process.send?.({ late: true }, (lateError: NodeJS.ErrnoException | null) => {
      console.log("late", lateError?.code, process.connected);
    });
    console.log("lateQueued", queued);
  });
});
