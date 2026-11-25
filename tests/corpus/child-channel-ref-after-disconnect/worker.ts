// Keeps running past the parent's exit so a channel that stayed reffed would
// hold the parent's loop open long enough to deliver this worker's 'exit'.
if (process.send) process.send({ hi: 1 });
setTimeout(() => process.exit(0), 1500);
