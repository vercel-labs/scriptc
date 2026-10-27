// Function.prototype.bind, call and apply on builtin static functions in
// JavaScript dependencies. The vendored truncate-utf8-bytes 1.0.2 (WTFPL)
// binds Buffer.byteLength at load time and calls the bound function per
// character; bound-builtins binds Buffer, Math, String and JSON statics.
// fs.realpath 1.0.0 (ISC) and value-forms read builtin functions as values:
// fs.realpathSync stored and compared, Buffer.alloc aliased, and a String
// method read for a feature probe.
import truncate from 'truncate-utf8-bytes';
import { report, badLength } from 'bound-builtins';
import realpath from 'fs.realpath';
import { report as valueForms, more as moreValueForms } from 'value-forms';

console.log(truncate('hello world', 5), truncate('héllo', 2), truncate('héllo', 3));
console.log(JSON.stringify(truncate('a😀b', 3)), JSON.stringify(truncate('a😀b', 5)), truncate('short', 99));
try {
  (truncate as unknown as (value: unknown, n: number) => string)(42, 1);
} catch (error) {
  console.log((error as Error).message);
}
for (const value of report()) console.log(value);
console.log(badLength());

console.log(realpath.realpathSync('/'), realpath.sync('/'));
realpath('/', (error, resolved) => console.log('async', error, resolved));
for (const value of valueForms()) console.log(value);
for (const value of moreValueForms()) console.log(value);
