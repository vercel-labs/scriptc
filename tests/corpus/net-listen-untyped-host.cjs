// server.listen with an untyped host, in both argument forms: a string is
// the host, and undefined or null is the absent host, every interface, as
// in Node. Each case prints the family and address it bound.
'use strict';
const net = require('net');

function positional(host, next) {
  const server = net.createServer();
  server.listen(0, host, () => {
    const bound = server.address();
    console.log('positional', String(host), bound.family, bound.address, bound.port > 0);
    server.close(next);
  });
}

function options(host, next) {
  const server = net.createServer();
  server.listen({ port: 0, host }, () => {
    const bound = server.address();
    console.log('options', String(host), bound.family, bound.address, bound.port > 0);
    server.close(next);
  });
}

const steps = [];
for (const host of ['127.0.0.1', undefined, null]) {
  steps.push((next) => positional(host, next));
  steps.push((next) => options(host, next));
}
function run(index) {
  if (index === steps.length) return console.log('done');
  steps[index](() => run(index + 1));
}
run(0);
