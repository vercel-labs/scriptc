// Console instances and the console object held as a value publish on the
// same console.<member> channels as the global methods, with the call's own
// argument array.
'use strict';
const { Console } = require('console');
const dc = require('diagnostics_channel');

const show = (value) => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return `object:${JSON.stringify(value)}`;
  return `${typeof value}:${String(value)}`;
};

const seen = [];
for (const name of ['console.log', 'console.info', 'console.debug', 'console.warn', 'console.error']) {
  dc.subscribe(name, (message) => seen.push([name, message.map(show)]));
}

const out = new Console({ stdout: process.stdout, stderr: process.stderr });
out.log('instance', 1, { a: 1 });
out.error('bad', false);

const value = console;
value.log('value', 2);
value.warn('careful');

process.stdout.write(`${JSON.stringify(seen)}\n`);
