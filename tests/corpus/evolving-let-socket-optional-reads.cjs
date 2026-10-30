'use strict';
// Optional reads and calls on a captured `let` socket, before and after
// its first write: undefined short-circuits, the socket answers.
const net = require('net');
let c;
const server = net.createServer((s) => s.end());
function report(label) {
  console.log(label, c?.remoteAddress, c?.address()?.family, c?.remotePort > 0);
}
report('before');
const early = () => console.log('arrow before', c?.remoteAddress ?? 'none');
early();
server.listen(0, '127.0.0.1', () => {
  c = net.connect(server.address().port, '127.0.0.1', () => {
    report('after');
    console.log('inside', c?.remoteAddress, c?.address()?.family);
    c.end();
    server.close();
  });
});
