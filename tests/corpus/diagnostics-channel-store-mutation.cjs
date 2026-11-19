// Channel.runStores takes its bindings before any transform runs, as Node
// builds its chain of store calls first: a transform that unbinds a store
// still leaves that store entered for the current run, later runs skip it,
// and a store bound during a transform joins the next run only.
'use strict';
const dc = require('diagnostics_channel');
const { AsyncLocalStorage } = require('async_hooks');

const a = new AsyncLocalStorage();
const b = new AsyncLocalStorage();
const c = new AsyncLocalStorage();
const added = new AsyncLocalStorage();
const channel = dc.channel('store-mutation');
const log = [];

channel.bindStore(a, (data) => {
  log.push('a');
  return 'A' + data;
});
channel.bindStore(b, (data) => {
  log.push('b');
  return 'B' + data;
});
channel.bindStore(c, (data) => {
  log.push('c');
  channel.unbindStore(b);
  return 'C' + data;
});

const returned = channel.runStores(1, () => {
  log.push(`body:${a.getStore()}${b.getStore()}${c.getStore()}`);
  return 'ret';
});
console.log(log.join(','), returned);

log.length = 0;
channel.runStores(2, () => log.push(`second:${a.getStore()}${b.getStore()}${c.getStore()}`));
console.log(log.join(','));

log.length = 0;
channel.bindStore(b, (data) => {
  log.push('b2');
  channel.bindStore(added, (value) => {
    log.push('added');
    return 'X' + value;
  });
  return 'B' + data;
});
channel.runStores(3, () => log.push(`third:${added.getStore()}`));
console.log(log.join(','));

log.length = 0;
channel.runStores(4, () => log.push(`fourth:${added.getStore()}`));
console.log(log.join(','));
