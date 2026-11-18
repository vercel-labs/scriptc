// A worker that never touches node:worker_threads: it only keeps its event
// loop alive, where Node answers the parent's cpuUsage() through an isolate
// interrupt.
setInterval(() => {}, 1000);
