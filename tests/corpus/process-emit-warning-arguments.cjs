// process.emitWarning's argument handling, in the order Node runs it: an
// options object replaces type with `options.type || "Warning"` and code
// with `options.code`; a function in the type position is the ctor; type
// and code are checked before the warning itself, for Error warnings too;
// an empty type names the warning "Warning". Wrong kinds throw
// ERR_INVALID_ARG_TYPE with Node's "Received ..." message. Under
// process.throwDeprecation the thrown deprecation is reported as the
// DeprecationWarning it is. The program re-runs itself and prints the
// child's output with process ids normalized.
"use strict";
const { spawnSync } = require("child_process");

class CustomWarning extends Error {
  constructor() {
    super("custom");
    this.name = "CustomWarning";
    this.code = "CW1";
  }
}

const mode = process.argv[2];
if (mode === "child") {
  process.on("warning", (w) => console.log("listener:", w.name, w.message, w.code, w.detail));
  // Untyped parameters: the arguments reach emitWarning as given. An
  // argument left out is undefined, which emitWarning treats as omitted.
  function emit(warning, type, code) {
    process.emitWarning(warning, type, code);
  }
  const ctor = function marker() {};
  const forms = [
    ["plain"],
    ["empty type", ""],
    ["undefined type", undefined, "C3"],
    ["typed", "TypedWarning", "C4"],
    ["ctor type", ctor],
    ["ctor code", "T5", ctor],
    ["options", { type: "OptWarning", code: "C6", detail: "more" }],
    ["options empty type", { type: "" }],
    ["options only code", { code: "C7" }],
    ["options zero type", { type: 0 }],
    ["options detail ignored", { type: "D", detail: 1 }],
    ["options third ignored", { type: "E" }, 5],
    [new Error("error warning"), "Ignored", "IGNORED"],
  ];
  for (const args of forms) emit(args[0], args[1], args[2]);
  // An instance of an Error subclass keeps its own name and code.
  process.emitWarning(new CustomWarning());
  emit(new CustomWarning(), "Ignored");

  const invalid = [
    [1],
    [{}],
    [true],
    [[]],
    [null],
    [],
    ["", 1],
    ["", null],
    ["", ["a"]],
    ["", true],
    ["", "", 1],
    ["", "", {}],
    ["", "", true],
    ["", "", []],
    ["", { type: 5 }],
    ["", { type: true }],
    ["", { code: 5 }],
    ["", { code: null }],
    [new Error("e"), 5],
    [new Error("e"), "T", 5],
    [5, 5],
    [undefined, "foo", "bar"],
    [undefined],
  ];
  for (const args of invalid) {
    try {
      emit(args[0], args[1], args[2]);
      console.log("no throw:", args.length);
    } catch (e) {
      console.log(e.name, e.code, e.message);
    }
  }

  // The deprecation fast path returns before any argument is checked.
  process.noDeprecation = true;
  emit(5, "DeprecationWarning");
  process.emitWarning("dropped", "DeprecationWarning", "DEP_X");
  process.noDeprecation = false;
  console.log("end of turn");
} else if (mode === "throw") {
  process.throwDeprecation = true;
  process.emitWarning("thrown deprecation", "DeprecationWarning", "DEP_THROWN");
  console.log("before the tick");
} else {
  const child = spawnSync(process.execPath, [process.argv[1], "child"], { encoding: "utf8" });
  console.log(`status: ${child.status}`);
  console.log(child.stdout);
  console.log(child.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
  const thrown = spawnSync(process.execPath, [process.argv[1], "throw"], { encoding: "utf8" });
  console.log(`throw status: ${thrown.status}`);
  console.log(thrown.stdout);
  console.log(thrown.stderr.includes("DeprecationWarning: thrown deprecation"));
}
