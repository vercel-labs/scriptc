// A stream's start step runs during construction and its first pull as a
// promise job after the script, in a program with no other asynchronous
// work.
const stream = new ReadableStream({
  start() {
    console.log("start");
  },
  pull(controller) {
    console.log("pull", controller.desiredSize, stream.locked);
    controller.enqueue("chunk");
    console.log("queued", controller.desiredSize);
  },
});
console.log("end", stream.locked);
