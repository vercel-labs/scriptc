// Without a 'multipleResolves' listener a second settle is silent: Node's
// promise hook checks its cached listener count at the settle, so no event
// is queued and DEP0160 is never emitted.
new Promise((resolve) => {
  resolve(1);
  resolve(2);
});
new Promise((resolve) => {
  resolve("kept");
  resolve("late");
});
setTimeout(() => console.log("done"), 1);
