// Sends long after the parent's timer: an unref'd channel must not keep
// the parent's loop alive waiting for this message, and the closed
// channel makes the send itself a no-op.
setTimeout(() => {
  if (process.connected && process.send) process.send({ late: true }, () => {});
}, 2000);
