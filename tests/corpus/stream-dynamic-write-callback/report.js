// A write completion callback built in JavaScript: it records how it was
// called. Module code is strict, so an unbound call sees `this` undefined.
export function makeReporter(lines, label) {
  return function (...args) {
    const error = args[0];
    lines.push(
      `${label} args=${args.length} error=${error === null ? "null" : error === undefined ? "undefined" : error.message} this=${typeof this}`,
    );
    return "ignored";
  };
}
