// writeHead(status, headers) with an untyped headers object stores each
// value as setHeader does: arrays send one line per element, numbers and
// other values send their string form, and undefined throws
// ERR_HTTP_INVALID_HEADER_VALUE. setHeader and appendHeader with a name
// that is not a string throw ERR_INVALID_HTTP_TOKEN with its string form
// (called on a response passed through an untyped helper).
'use strict';
const http = require('http');

function attempt(label, fn) {
  try {
    fn();
    console.log(label, 'ok');
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

function setOn(target, name, value) {
  target.setHeader(name, value);
}

function appendOn(target, name, value) {
  target.appendHeader(name, value);
}

const values = [['X-List', ['a', 'b']], ['X-Num', 42], ['X-Bool', true], ['X-Null', null]];
let round = 0;
const server = http.createServer((req, res) => {
  round++;
  if (round === 1) {
    const headers = {};
    for (const [name, value] of values) headers[name] = value;
    attempt('number name', () => setOn(res, 3840, 'x'));
    attempt('number append name', () => appendOn(res, 12, 'x'));
    res.writeHead(200, headers);
  } else {
    const headers = {};
    headers['X-Undefined'] = undefined;
    attempt('undefined value', () => res.writeHead(200, headers));
  }
  res.end('ok');
});

function get(then) {
  http.get({ port: server.address().port }, (res) => {
    const raw = [];
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      if (res.rawHeaders[i].startsWith('X-')) raw.push(`${res.rawHeaders[i]}=${res.rawHeaders[i + 1]}`);
    }
    console.log('response', res.statusCode, raw.join(' '));
    res.resume();
    res.on('end', then);
  });
}

server.listen(0, () => get(() => get(() => server.close())));
