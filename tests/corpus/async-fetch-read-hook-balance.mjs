import { createServer } from "node:http";
import { createHook } from "node:async_hooks";

let befores = 0;
let afters = 0;
createHook({
  before() {
    befores++;
  },
  after() {
    afters++;
  },
}).enable();

const server = createServer((_request, response) => {
  response.end("hello");
});
await new Promise((resolve) => server.listen(0, resolve));
const { port } = server.address();

async function reads(count) {
  for (let i = 0; i < count; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    await response.text();
  }
}

await reads(1);
const baseB = befores;
const baseA = afters;
await reads(4);
const fewB = befores - baseB;
const fewA = afters - baseA;
await reads(45);
const manyB = befores - baseB - fewB;
const manyA = afters - baseA - fewA;
server.close();
console.log(`five ${fewB - fewA} forty-five ${manyB - manyA}`);
