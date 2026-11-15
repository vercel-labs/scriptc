// @normalize-pid
// The 'multipleResolves' family: a resolve or reject that reaches an
// already-resolved promise reports (type, promise, value) on the nextTick
// queued at that settle, in settle order. `once` removes before delivery,
// off/removeListener remove by identity, and a listener list emptied before
// the tick runs sees nothing (no DEP0160 either). The first delivery that
// reaches a listener warns DEP0160 once per process.
const show = (what) => (type, promise, value) =>
  console.log(what, type, value instanceof Error ? `Error: ${value.message}` : value, typeof promise);
const swallow = (p) => p.catch(() => {});
process.on('multipleResolves', show('on'));
swallow(new Promise((resolve) => {
  resolve(1);
  resolve(2);
}));
swallow(new Promise((resolve, reject) => {
  reject(new Error('first'));
  reject(new Error('second'));
}));
swallow(new Promise((resolve, reject) => {
  resolve('kept');
  reject(new Error('late reject'));
}));
swallow(new Promise((resolve, reject) => {
  reject(new Error('early reject'));
  resolve('late resolve');
}));
swallow(new Promise((resolve) => {
  resolve(true);
  throw new Error('executor throw after resolve');
}));
console.log('settles done');
