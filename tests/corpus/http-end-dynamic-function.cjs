// end() decides by typeof, not by position: a checked-dynamic argument
// that holds a function is the end callback, and a checked-dynamic
// argument that holds a string is the chunk — on the response and on the
// client request alike. Both messages end through their dynamic chunk
// entry, which makes the same decision at run time.
'use strict';
const http = require('http');

function wrap(fn) {
  return function() {
    return fn.apply(this, arguments);
  };
}

// A value the compiler sees only as dynamic.
function dyn(value) {
  return value;
}

const server = http.createServer();
server.on('request', wrap(function(req, res) {
  if (req.url === '/server-callback') {
    res.end(dyn(wrap(function() {
      console.log('server end callback');
    })));
    return;
  }
  let body = '';
  req.on('data', wrap(function(c) { body += c; }));
  req.on('end', wrap(function() {
    res.end(dyn('echo:' + body));
  }));
}));

function send(port, path, payload, done) {
  const out = http.request({ host: '127.0.0.1', port: port, path: path, method: 'POST' }, wrap(function(res) {
    let body = '';
    res.on('data', wrap(function(c) { body += c; }));
    res.on('end', wrap(function() {
      console.log(path + ': ' + res.statusCode + ' ' + body);
      done();
    }));
  }));
  out.end(payload);
}

server.listen(0, '127.0.0.1', wrap(function() {
  const port = server.address().port;
  send(port, '/echo', dyn('dyn chunk'), function() {
    send(port, '/client-callback', dyn(wrap(function() {
      console.log('client end callback');
    })), function() {
      send(port, '/server-callback', dyn('final'), function() {
        server.close();
      });
    });
  });
}));
