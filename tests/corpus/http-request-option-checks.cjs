// http.request runs Node's option checks on untyped values in an options
// literal: a method, hostname or host that is not a string throws
// ERR_INVALID_ARG_TYPE naming the option, undefined and null take the
// defaults, and a port string that is not a port throws ERR_SOCKET_BAD_PORT.
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

for (const method of [-1, {}, true, []]) {
  attempt('method', () => http.request({ method, path: '/' }, () => {}));
}
for (const hostname of [1, [], new Date(), false]) {
  attempt('hostname', () => http.request({ hostname }));
}
for (const host of [NaN, {}]) {
  attempt('host', () => http.request({ host }));
}
[undefined, null, 'GET', 'post'].forEach((method) => {
  attempt(`method ${method}`, () => {
    const req = http.request({ method, port: 1, agent: false });
    req.on('error', () => {});
    req.destroy();
  });
});
const port = 'x';
attempt('port', () => http.request({ port }));
