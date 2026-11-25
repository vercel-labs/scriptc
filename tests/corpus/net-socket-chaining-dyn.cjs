'use strict';
// The same chaining and setKeepAlive surface through checked-dynamic calls:
// bracket lookups and values of unknown type dispatch at run time, so the
// object form, missing arguments, non-boolean enable values and the
// ToNumber hooks all take the runtime's path. setEncoding() with no
// argument means utf8 here too. Every line prints from the server's side,
// or after the client's 'end', so the loopback race cannot reorder them.
const net = require('net');

function wrap(fn) {
  return function () {
    return fn.apply(this, arguments);
  };
}

/* The calls below run through an untyped parameter, so their member lookups
 * dispatch at run time instead of resolving statically. */
function setEncodingDefault(target) {
  return target['setEncoding'](undefined) === target;
}

function destroyChain(target) {
  return target['destroy']() === target;
}

let reported = false;
const server = net.createServer(wrap(function (sock) {
  if (reported) {
    sock.destroy();
    return;
  }
  reported = true;
  console.log('encoding default:', sock['setEncoding']() === sock);
  console.log('nodelay default:', sock['setNoDelay'](undefined) === sock);
  console.log('keepalive none:', sock['setKeepAlive']() === sock);
  console.log('keepalive 4 args:', sock['setKeepAlive'](true, 1000, 500, 7) === sock);
  console.log('keepalive object:', sock['setKeepAlive']({ enable: true, initialDelay: 1000, interval: 500, count: 2 }) === sock);
  console.log('keepalive null:', sock['setKeepAlive'](null) === sock);
  console.log('keepalive NaN:', sock['setKeepAlive'](NaN) === sock);
  console.log('keepalive string:', sock['setKeepAlive']('yes') === sock);
  console.log('keepalive empty object:', sock['setKeepAlive']({}) === sock);
  console.log('timeout chain:', sock['setTimeout'](0) === sock);
  console.log('ref/unref chain:', sock['ref']() === sock, sock['unref']() === sock);
  const trap = { valueOf: wrap(function () { throw new Error('trap'); }) };
  try {
    sock['setKeepAlive'](true, trap);
  } catch (error) {
    console.log('delay hook:', error.name, error.message);
  }
  sock.on('data', wrap(function (chunk) {
    console.log('server chunk type:', typeof chunk, chunk);
    console.log('end chain:', sock['end']('bye') === sock);
  }));
}));

server.listen(0, '127.0.0.1', wrap(function () {
  const client = net.connect(server.address().port, '127.0.0.1');
  client.on('connect', wrap(function () {
    client.write('ping');
  }));
  client.on('error', wrap(function () {}));
  console.log('client enc:', setEncodingDefault(client));
  client.on('data', wrap(function (chunk) {
    console.log('client chunk type:', typeof chunk, chunk);
  }));
  client.on('end', wrap(function () {
    console.log('client end');
  }));
  client.on('close', wrap(function () {
    const scratch = net.connect(server.address().port, '127.0.0.1');
    scratch.on('error', wrap(function () {}));
    console.log('destroy chain:', destroyChain(scratch));
    scratch.on('close', wrap(function () {
      console.log('server close chain:', server.close() === server);
    }));
  }));
}));
