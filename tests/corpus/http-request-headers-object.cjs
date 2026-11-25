// req.headers read from untyped code (here a request passed through an
// untyped helper) is one object per message, as in Node: reads answer the
// same object, and deleting or adding a key persists.
'use strict';
const http = require('http');

function edit(message) {
  console.log('same object', message.headers === message.headers);
  delete message.headers.host;
  message.headers['x-added'] = 'yes';
  console.log('after edits', JSON.stringify(message.headers));
  console.log('x-a', message.headers['x-a'], 'host', message.headers.host);
}

const server = http.createServer((req, res) => {
  edit(req);
  res.end();
  server.close();
});

server.listen(0, '127.0.0.1', () => {
  http.get({ host: '127.0.0.1', port: server.address().port, headers: { 'x-a': 'b' } }, (res) => res.resume());
});
