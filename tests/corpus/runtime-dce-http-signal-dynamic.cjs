// A checked-dynamic IncomingMessage keyed by a computed name reaches the
// message's abort signal: the dyn handle's key get dispatches "signal" to
// the http unit's abort helpers, so a program that combines node:http with
// a runtime-key read must still link scr_abort.c (runtime-features'
// dynSignalKey fact, gated on http). A build that dropped the unit answers
// the SC2020 "not supported by this runtime build" error instead of Node's
// AbortSignal.
'use strict';
const http = require('node:http');

let wrappers = 0;
function dynamicListener(fn) {
  wrappers++;
  return function () {
    return fn.apply(this, arguments);
  };
}

const server = http.createServer();
server.on('request', dynamicListener(function (req, res) {
  const key = ['sig', 'nal'].join('');
  const signal = req[key];
  console.log('signal type: ' + typeof signal);
  console.log('aborted: ' + signal.aborted);
  res.writeHead(200, { 'content-type': 'text/plain' }).end('signal-probed');
}));

server.listen(0, '127.0.0.1', dynamicListener(function () {
  const port = server.address().port;
  http.get({ host: '127.0.0.1', port: port, path: '/signal' }, dynamicListener(function (res) {
    let body = '';
    res.on('data', dynamicListener(function (chunk) {
      body += chunk;
    }));
    res.on('end', dynamicListener(function () {
      console.log('client status ' + res.statusCode);
      console.log('body ' + body);
      console.log('wrappers ' + (wrappers >= 4 ? 'several' : 'few'));
      server.close();
    }));
  }));
}));
