// A built-in global named through the global object is the built-in its
// bare name names: `globalThis.fetch(…)` and `global.fetch(…)` call
// `fetch`, `new globalThis.URL(…)` constructs a URL, and a read of one
// that has a value reads that value. A read of one the compiler has no
// value for is refused where the statement runs, so in code the program
// never reaches it costs nothing.
import * as http from 'node:http';

const order: string[] = [];

globalThis.queueMicrotask(() => order.push('micro'));
global.queueMicrotask(() => order.push('micro2'));
order.push('sync');

const original = { list: [1, 2, 3], name: 'x', nested: { deep: true } };
const copy = globalThis.structuredClone(original);
const copy2 = global.structuredClone(original);
console.log(
  JSON.stringify(copy),
  copy !== original,
  copy.list !== original.list,
  JSON.stringify(copy2) === JSON.stringify(copy),
);

const url = new globalThis.URL('https://example.com/a/b?c=1#d');
const url2 = new global.URL('/x', url);
console.log(url.pathname, url.search, url.hash, url2.href, url instanceof URL);
console.log(Array.from(new globalThis.TextEncoder().encode('hé')).join(','));
const controller = new globalThis.AbortController();
controller.abort();
console.log(controller.signal.aborted, new global.AbortController().signal.aborted);

console.log(typeof globalThis.fetch, typeof global.setTimeout, typeof globalThis.URL);
console.log(globalThis.parseInt('42px', 10), global.isNaN(Number('x')), globalThis.encodeURIComponent('a b&c'));
console.log(globalThis.btoa('hi'), global.atob('aGk='), globalThis.Symbol('s').toString());

function unreached(): void {
  const later = globalThis.setTimeout;
  const { queueMicrotask: soon, clearTimeout: stop } = globalThis;
  const again = global.setInterval;
  console.log(typeof later, typeof soon, typeof stop, typeof again);
}
console.log(typeof unreached);

const server = http.createServer((req, res) => {
  res.end(`${req.method} ${req.url}`);
});
server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as { port: number }).port;
  const first = await globalThis.fetch(`http://127.0.0.1:${port}/one`, { method: 'POST' });
  const second = await global.fetch(`http://127.0.0.1:${port}/two`);
  const viaValue = globalThis.fetch;
  const third = await viaValue(`http://127.0.0.1:${port}/three`, { method: 'PUT' });
  console.log(first.status, await first.text(), '|', await second.text(), '|', await third.text());
  server.close();

  const timer = globalThis.setTimeout(() => order.push('never'), 1000);
  global.clearTimeout(timer);
  let ticks = 0;
  const interval = globalThis.setInterval(() => {
    ticks++;
    if (ticks === 2) {
      global.clearInterval(interval);
      globalThis.setImmediate(() => {
        order.push('immediate');
        global.setTimeout(() => {
          order.push('timeout');
          console.log(order.join(','), ticks);
        }, 1);
      });
    }
  }, 1);
});
