// A module the program compiles (SPEC §5.4): the program registers into it
// natively, and a run-time require that names the same file must not hand
// back a second copy with its own registry.
const entries = new Map();
exports.register = (name) => entries.set(name, true);
exports.size = () => entries.size;
