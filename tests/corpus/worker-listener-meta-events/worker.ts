// Stays alive until the parent terminates it, so the parent's listener
// bookkeeping events are the only ones that run in the main thread.
setInterval(() => {}, 1000);
