// server.listen(value) with an untyped value: a function is the 'listening'
// callback on an arbitrary unused port, as in Node; a number is the port.
'use strict';
const http = require('http');

function wrap(fn) {
  return function (...args) {
    return fn.apply(this, args);
  };
}

const server = http.createServer((req, res) => res.end('ok'));
server.listen(wrap(() => {
  const port = server.address().port;
  console.log('port > 0', port > 0);
  server.close(() => {
    const other = http.createServer();
    const chosen = [0][0];
    other.listen(chosen, wrap(() => {
      console.log('numeric port > 0', other.address().port > 0);
      other.close();
    }));
  });
}));
