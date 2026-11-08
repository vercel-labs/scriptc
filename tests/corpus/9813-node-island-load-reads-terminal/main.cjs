// @requires-libnode
// Island packages whose load asks about the terminal: isTTY, tty.isatty(),
// TERM, NO_COLOR and FORCE_COLOR as colour detection does, and the members
// only a terminal's stream has (getColorDepth, hasColors, columns, rows).
// The build records these loads with its own streams, which are never a
// terminal. `isTTY` was a boot guard; a member that is absent on a pipe was
// read without the recorder seeing it, and the executable answered
// "no such member" on a terminal. Each of them is now the same guard: the
// module waits where the stream is what the build saw, and evaluates at its
// import where it is not.
const term = require("term-kit");
const colour = require("colour-kit");

// Printed as text: a run that forces colour would colour the values.
console.log(`getColorDepth: ${term.depth} hasColors: ${term.colours}`);
console.log(`sized: ${term.sized} getWindowSize: ${term.window}`);
console.log(`isatty: ${term.isatty} ${term.error}`);
console.log(`colour: ${colour.stdout} ${colour.stderr}`);
