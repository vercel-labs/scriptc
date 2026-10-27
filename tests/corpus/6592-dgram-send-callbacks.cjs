// dgram.Socket.send's callback forms from JavaScript: the offset/length
// form with a trailing callback, the port/address form with one, a buffer
// list sent as one datagram, and a connected socket's send. Each callback
// receives (null, bytes) after the send; a closed socket throws first.
'use strict';
const dgram = require('dgram');

const server = dgram.createSocket('udp4');
const got = [];
server.on('message', (msg) => {
  got.push(msg.toString());
});

function run(port) {
  const client = dgram.createSocket('udp4');
  const steps = [];
  const done = (label) => (err, bytes) => steps.push(`${label} ${err} ${bytes}`);
  const buf = Buffer.from('xxhello.sliceyy');
  client.send(buf, 2, 11, port, '127.0.0.1', done('slice'));
  client.send('plain', port, '127.0.0.1', done('plain'));
  client.send(['li', Buffer.from('st'), 'ed'], port, '127.0.0.1', done('list'));
  client.send(Buffer.from('nocb'), 0, 4, port, '127.0.0.1');
  const connected = dgram.createSocket('udp4');
  connected.connect(port, '127.0.0.1', () => {
    connected.send('connected', done('connected'));
    setTimeout(() => {
      console.log(steps.join('\n'));
      console.log(got.sort().join(','));
      client.close();
      connected.close();
      try {
        client.send('late', port, '127.0.0.1', done('late'));
      } catch (e) {
        console.log(`${e.code}: ${e.message}`);
      }
      server.close();
    }, 100);
  });
}

server.bind(0, '127.0.0.1', () => run(server.address().port));
