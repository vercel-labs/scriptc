// A reader's closed handler that releases the lock while the stream closes
// runs during the close itself: the close still answers the pending reads
// and the process ends normally.
let reader;
const stream = new ReadableStream({
  start(controller) {
    setTimeout(() => controller.close(), 0);
  },
});
reader = stream.getReader();
reader.closed.then(() => {
  reader.releaseLock();
  reader = null;
});
setTimeout(() => console.log("done"), 10);
