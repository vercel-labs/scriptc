// write(chunk, callback) callbacks that report their `this`; module code is
// strict, so an unbound call sees undefined.
export function makeCallback(seen, name, holder) {
  return function () {
    seen.push(`${name} this=${this === undefined ? "undefined" : this === holder ? "holder" : typeof this}`);
  };
}

// Calls holder.run() as a method from JavaScript: run's own call of the
// saved completion happens while this call's receiver is the holder.
export function callRun(holder) {
  holder.run();
}
