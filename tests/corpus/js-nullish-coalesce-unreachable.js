// The checker reports TS2869 on the last operand of a `??` chain built from
// an untyped Map: `files.get(name)` comes back as any, and the middle arm's
// `void 0` is read as if the chain could not be nullish. Node evaluates the
// chain left to right and does evaluate the last fallback, so the program
// compiles with the ordinary `??` lowering and keeps Node's verdicts.

const files = new Map();
files.set("present", { type: "file" });
files.set("both", { type: "file" });

const dirs = new Map();
dirs.set("folder", { type: "tree" });
dirs.set("both", { type: "tree" });

let fallbackCalls = 0;

/** @param {string} name */
function fallback(name) {
  fallbackCalls += 1;
  return { type: "fallback:" + name };
}

/** @param {string} name */
function entry(name) {
  return files.get(name) ?? (dirs.has(name) ? { type: "tree" } : void 0) ?? fallback(name);
}

console.log(entry("present").type, fallbackCalls);
console.log(entry("folder").type, fallbackCalls);
console.log(entry("both").type, fallbackCalls);
console.log(entry("missing").type, fallbackCalls);

// The same chain shape over a typed Map, where the middle arm decides.
/** @type {Map<string, { type: string }>} */
const typedFiles = new Map();
typedFiles.set("kept", { type: "typed-file" });

/** @param {string} name */
function typedEntry(name) {
  return typedFiles.get(name) ?? (dirs.has(name) ? { type: "tree" } : void 0) ?? fallback(name);
}

console.log(typedEntry("kept").type, fallbackCalls);
console.log(typedEntry("folder").type, fallbackCalls);
console.log(typedEntry("absent").type, fallbackCalls);
