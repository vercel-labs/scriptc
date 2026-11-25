// A server request whose response is unfinished when the client goes away
// is destroyed as Node's abortIncoming destroys it: 'aborted' fires with
// aborted and destroyed set (complete stays true once the request arrived),
// then the response's 'close', the request's 'error' (ECONNRESET, "aborted")
// and its 'close'. Without an 'error' listener nothing is thrown. A request
// whose response finished is not aborted.
'use strict';
const http = require('http');

let round = 0;
const server = http.createServer((req, res) => {
  round++;
  const tag = `round ${round}`;
  req.on('aborted', () => console.log(tag, 'req aborted', req.aborted, req.destroyed, req.complete));
  if (round === 1) req.on('error', (e) => console.log(tag, 'req error', e.code, e.message));
  req.on('close', () => {
    console.log(tag, 'req close', req.aborted, req.destroyed);
    next();
  });
  res.on('close', () => console.log(tag, 'res close', res.destroyed, res.writableEnded));
  if (round === 3) {
    res.end('done');
    return;
  }
  res.write('partial');
});

// The server request's 'close' starts the next round.
function next() {
  if (round === 3) {
    server.close();
    return;
  }
  const req = http.get({ port: server.address().port, agent: false }, (res) => {
    if (round < 3) res.once('data', () => req.destroy());
    else res.resume();
  });
  req.on('error', () => {});
}

server.listen(0, next);
