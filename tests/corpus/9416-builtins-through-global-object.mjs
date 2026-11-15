// The JavaScript twin of 9415: built-in globals named through the global object.
import * as http from 'node:http';

const order = [];

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

const server = http.createServer((req, res) => {
  res.end(`${req.method} ${req.url}`);
});
server.listen(0, '127.0.0.1', async () => {
  const port = (server.address()).port;
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
