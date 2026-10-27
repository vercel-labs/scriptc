// A record type the program both builds with an object literal and reads
// back with a typed JSON.parse: the literal enumerates in its own key order
// (not the declaration's), values parsed from the JSON it wrote keep that
// order, and values parsed from JSON in another order keep theirs.
interface Order {
  id: string;
  region: string;
}
interface Message {
  order: Order;
  outputs: string[];
  traceCarrier?: Record<string, string>;
  pollMs: number;
}

function encode(order: Order, outputs: string[], pollMs: number): string {
  const message: Message = { outputs, order, pollMs };
  return JSON.stringify(message);
}

function decode(text: string): Message {
  return JSON.parse(text) as Message;
}

const wire = encode({ region: "iad1", id: "o1" }, ["a", "b"], 250);
console.log(wire);
const back = decode(wire);
console.log(JSON.stringify(back), Object.keys(back).join(","), Object.keys(back.order).join(","));

const external = decode('{"pollMs":5,"order":{"id":"o2","region":"sfo1"},"outputs":[],"traceCarrier":{"t":"1"}}');
console.log(JSON.stringify(external), Object.keys(external).join(","));

const declared = decode('{"order":{"id":"o3","region":"fra1"},"outputs":["x"],"pollMs":1}');
console.log(JSON.stringify(declared), Object.keys(declared).join(","));
for (const [key, value] of Object.entries(back)) console.log(key, value !== undefined ? JSON.stringify(value) : "-");
