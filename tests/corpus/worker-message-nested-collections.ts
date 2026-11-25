import { MessageChannel } from "node:worker_threads";

// Collections nest as deeply as the value does: the encoder walks them on its
// own stack, not the C stack, so a chain of Maps or Sets cannot overflow it,
// and it never holds a pointer into a table that a nested value can grow.
// (Node refuses a nesting thousands deep with a RangeError, where this runtime
// still encodes it; the depth here is one Node also accepts.)
const { port1, port2 } = new MessageChannel();
const depth = 200;

const mapRoot = new Map<string, unknown>();
let map = mapRoot;
for (let i = 0; i < depth; i++) {
  const next = new Map<string, unknown>();
  map.set("n", next);
  map = next;
}
map.set("leaf", "bottom");

const setRoot = new Set<unknown>();
let set = setRoot;
for (let i = 0; i < depth; i++) {
  const next = new Set<unknown>();
  set.add(next);
  set = next;
}
set.add("bottom");

port1.on("message", (value: any) => {
  let maps = 0;
  let current: any = value.maps;
  while (current instanceof Map && current.has("n")) {
    current = current.get("n");
    maps += 1;
  }
  let sets = 0;
  let currentSet: any = value.sets;
  while (currentSet instanceof Set) {
    const [next] = currentSet;
    if (!(next instanceof Set)) break;
    currentSet = next;
    sets += 1;
  }
  console.log("maps", maps, current.get("leaf"), "sets", sets, [...currentSet][0]);
  port1.close();
  port2.close();
});
port1.start();
port2.postMessage({ maps: mapRoot, sets: setRoot });
