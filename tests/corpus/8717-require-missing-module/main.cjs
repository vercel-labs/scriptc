// require() of a relative path that names no file throws Node's
// MODULE_NOT_FOUND where the call sits: as a statement (top level, inside
// a function, under void), in a binding and in every expression position.
// The message carries the requiring file, so the directory is cut out.
function show(label, e) {
  console.log(
    label,
    e instanceof Error,
    e.name,
    e.code,
    JSON.stringify(e.message.split(__dirname).join("<dir>")),
  );
}

// Statements: nothing after the require runs.
try {
  console.log("statement: before");
  require("./not-there.cjs");
  console.log("statement: no throw");
} catch (e) {
  show("statement", e);
}
try {
  void require("./void-missing.cjs");
  console.log("void: no throw");
} catch (e) {
  show("void", e);
}
function inside() {
  require("./function-missing.cjs");
  return "function: no throw";
}
try {
  console.log(inside());
} catch (e) {
  show("function", e);
}
try {
  require("../parent-missing");
  console.log("parent: no throw");
} catch (e) {
  show("parent", e);
}
try {
  require("./missing.json");
  console.log("json: no throw");
} catch (e) {
  show("json", e);
}
try {
  require("./no-such-directory/");
  console.log("directory: no throw");
} catch (e) {
  show("directory", e);
}

// Bindings: the declaration throws before the binding exists.
try {
  const bound = require("./bound-missing.cjs");
  console.log("bound: no throw", typeof bound);
} catch (e) {
  show("bound", e);
}
try {
  const { member } = require("./destructured-missing.cjs");
  console.log("destructured: no throw", member);
} catch (e) {
  show("destructured", e);
}
try {
  let late;
  late = require("./assigned-missing.cjs");
  console.log("assigned: no throw", typeof late);
} catch (e) {
  show("assigned", e);
}

// Expressions.
try {
  console.log("argument: no throw", typeof require("./argument-missing.cjs"));
} catch (e) {
  show("argument", e);
}
try {
  const fallback = require("./or-missing.cjs") || {};
  console.log("or: no throw", typeof fallback);
} catch (e) {
  show("or", e);
}
try {
  if (require("./condition-missing.cjs")) console.log("condition: no throw");
} catch (e) {
  show("condition", e);
}
try {
  require("./member-missing.cjs").value;
  console.log("member: no throw");
} catch (e) {
  show("member", e);
}
try {
  require("./call-missing.cjs")();
  console.log("call: no throw");
} catch (e) {
  show("call", e);
}
const lazy = () => require("./arrow-missing.cjs");
try {
  lazy();
  console.log("arrow: no throw");
} catch (e) {
  show("arrow", e);
}

// The optional-dependency idiom, and the same error twice.
function optional() {
  try {
    return require("./optional-missing.cjs");
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
    return null;
  }
}
console.log("optional", optional(), optional());

// Files that exist still load, once, where the require sits.
const present = require("./present.cjs");
require("./present.cjs");
console.log(present.name, present.loads(), require("./data.json").answer);

// The top-level statement outside try ends the module's evaluation.
process.on("uncaughtException", (e) => {
  show("uncaught", e);
});
console.log("top level: before");
require("./top-level-missing.cjs");
console.log("top level: no throw");
