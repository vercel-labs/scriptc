"use strict";
// A closure inside a destructuring declaration's initializer can read the
// names the declaration binds, as React's
// `const { pipe } = renderToPipeableStream(app, { onShellReady() { pipe(out); } })`
// does. Before the destructuring completes, the read throws Node's
// ReferenceError.
function start(options) {
  if (options.early) options.early();
  setTimeout(() => options.ready(), 1);
  return { pipe: (target) => console.log("piped", target), abort: () => console.log("aborted") };
}

function render(destination) {
  const { pipe, abort: stop } = start({
    ready() {
      pipe(destination);
      stop();
    },
  });
}

function readTooEarly() {
  try {
    const { pipe } = start({
      early() {
        pipe("too early");
      },
      ready() {},
    });
  } catch (error) {
    console.log(error.constructor.name, error.message);
  }
}

function nested(label) {
  const [count, { report }] = [2, { report: () => console.log("report", label, count) }];
  let { list: [first] = [] } = {
    list: [
      () => {
        console.log("first", label);
        report();
      },
    ],
  };
  setTimeout(() => first(), 2);
}

render("page");
readTooEarly();
nested("nested");
