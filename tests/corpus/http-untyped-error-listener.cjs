// An 'error' listener attached through an untyped value receives the Error a
// typed listener receives: an Error instance with Node's code and a
// non-enumerable message, for an aborted response and a refused connection.
'use strict';
const http = require('http');
const net = require('net');

function describe(label, e) {
  const message = e.message.startsWith('connect ECONNREFUSED') ? 'connect ECONNREFUSED' : e.message;
  console.log(label, e instanceof Error, e.name, e.code, message, Object.prototype.propertyIsEnumerable.call(e, 'message'));
}

// emitter is untyped here: on() dispatches at run time
function listen(emitter, label, then) {
  emitter.on('error', (e) => {
    describe(label, e);
    if (then) then();
  });
}

let serverRes;
const server = http.createServer((req, res) => {
  res.write('part');
  serverRes = res;
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  http.get({ host: '127.0.0.1', port }, (res) => {
    listen(res, 'response', () => {
      server.close(() => {
        const sock = net.connect(port, '127.0.0.1');
        listen(sock, 'socket');
      });
    });
    serverRes.destroy();
  });
});
