// @normalize-pid
// The multipleResolves listener lifecycle: off/removeListener remove by
// identity, a listener list emptied between the settle that queued the
// event and the tick that delivers it sees nothing (the tick re-checks the
// registry), and `once` leaves the list before its delivery, so the second
// settled promise's queued event reaches no listener. Only the delivery
// that reaches a listener (the once one) warns DEP0160.
function removed(type) {
  console.log('removed listener must never run', type);
}
process.on('multipleResolves', removed);
process.off('multipleResolves', removed);
new Promise((resolve) => {
  resolve(1);
  resolve(2);
});
process.nextTick(() => console.log('tick ordered after the dropped event'));
process.once('multipleResolves', (type) => console.log('once', type));
new Promise((resolve) => {
  resolve(3);
  resolve(4);
});
new Promise((resolve) => {
  resolve(5);
  resolve(6);
});
console.log('settles done');
