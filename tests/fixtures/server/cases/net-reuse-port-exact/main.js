/* Node checks reusePort with === true, rather than JavaScript truthiness.
 * The JSDoc any binding makes the non-boolean value a valid JavaScript
 * input to the typed listen surface. A truthiness lowering would enable the
 * second bind on Linux; Node and the native lane must both report EADDRINUSE. */
'use strict';
const net = require('net');

const first = net.createServer();
first.listen({ port: 0, host: '127.0.0.1' }, function() {
  const port = first.address().port;
  const badReusePort = 1;
  const second = net.createServer();
  second.on('error', function(error) {
    console.log(error.message.startsWith('listen EADDRINUSE: address already in use 127.0.0.1:')
      ? 'exact false' : `unexpected ${error.message}`);
    first.close();
  });
  second.listen({ port, host: '127.0.0.1', reusePort: badReusePort });
});
