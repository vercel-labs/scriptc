// The BroadcastChannel, MessageChannel and MessagePort globals are the
// worker_threads classes: a channel receives messages posted by another
// channel of the same name (never its own), entangled ports deliver to each
// other asynchronously, and instanceof names the global class.
const first = new BroadcastChannel("room");
const second = new BroadcastChannel("room");
const seen: string[] = [];
first.onmessage = (event) => {
  seen.push(`first:${String(event.data)}`);
};
second.onmessage = (event) => {
  seen.push(`second:${String(event.data)}`);
};
first.postMessage("hello");
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("broadcast", seen.join(","), first.name, second.name);
console.log("ref", first.ref().unref() === first, second.ref() === second);
first.close();
second.close();
