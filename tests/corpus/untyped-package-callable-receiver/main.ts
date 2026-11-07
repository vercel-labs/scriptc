// The untyped `readStream` helper takes its callback through `wrap`, which
// returns a bound function, so the parameter's checker type is untyped while
// the value is a compiled function. `callback.apply(null, args)` dispatches
// through Function.prototype on the receiver's runtime kind.
import read from "stream-invoke";

read({}, (err: unknown, buf: unknown) => {
  console.log("callback", err, buf);
});

const inline = read({});
console.log("inline", inline);
console.log("end");
