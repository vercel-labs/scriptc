"use strict";
// A minimal test/common for building Node's test/parallel files with scriptc:
// the helpers those files use, with the semantics of Node's
// test/common/index.js. Add a helper here, with Node's semantics, when a
// lane's files need it.
const assert = require("assert");
const { inspect } = require("util");

const hasIntl = true;
const isDebug = false;
const isWindows = process.platform === "win32";
const mustCallChecks = [];

function runCallChecks(exitCode) {
  if (exitCode !== 0) return;
  const failed = mustCallChecks.filter((context) => {
    if ("minimum" in context) return context.actual < context.minimum;
    return context.actual !== context.exact;
  });
  for (const context of failed) {
    console.log(
      "Mismatched %s function calls. Expected %s, actual %d.",
      context.name,
      String(context.exact ?? context.minimum),
      context.actual,
    );
  }
  if (failed.length) process.exit(1);
}

function noop() {}

function mustCallInner(fn, criteria, field) {
  if (typeof fn === "number") {
    criteria = fn;
    fn = noop;
  } else if (fn === undefined) {
    fn = noop;
  }
  if (criteria === undefined) criteria = 1;
  const context = { actual: 0, name: fn.name || "<anonymous>" };
  context[field] = criteria;
  if (mustCallChecks.length === 0) process.on("exit", runCallChecks);
  mustCallChecks.push(context);
  return function (...args) {
    context.actual++;
    return fn.apply(this, args);
  };
}

function mustCall(fn, exact) {
  return mustCallInner(fn, exact, "exact");
}

function mustCallAtLeast(fn, minimum) {
  return mustCallInner(fn, minimum, "minimum");
}

function mustNotCall(msg) {
  return function mustNotCall() {
    assert.fail(msg || "function should not have been called");
  };
}

function skip(msg) {
  console.log(`1..0 # Skipped: ${msg}`);
  process.exit(0);
}

function expectWarning(name, expected, code) {
  if (typeof expected === "string") expected = [[expected, code]];
  else if (expected.length !== 0 && !Array.isArray(expected[0]))
    expected = [[expected[0], expected[1]]];
  const check = mustCall((warning) => {
    const [message, warningCode] = expected.shift();
    assert.strictEqual(warning.name, name);
    if (typeof message === "string") assert.strictEqual(warning.message, message);
    else assert.match(warning.message, message);
    assert.strictEqual(warning.code, warningCode);
  }, expected.length);
  process.on("warning", (warning) => {
    if (warning.name !== name)
      throw new TypeError(`"${warning.name}" was triggered without being expected.`);
    check(warning);
  });
}

function invalidArgTypeHelper(input) {
  if (input == null) return ` Received ${input}`;
  if (typeof input === "function") return ` Received function ${input.name}`;
  if (typeof input === "object") {
    const name = input.constructor?.name;
    if (typeof name === "string" && name !== "") return ` Received an instance of ${name}`;
    return ` Received ${inspect(input, { depth: -1 })}`;
  }
  let inspected = inspect(input, { colors: false });
  if (inspected.length > 28) inspected = `${inspected.slice(inspected, 0, 25)}...`;
  return ` Received type ${typeof input} (${inspected})`;
}

function spawnPromisified(...args) {
  const { spawn } = require("child_process");
  let stderr = "";
  let stdout = "";
  const child = spawn(...args);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  return new Promise((resolve, reject) => {
    child.on("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
    child.on("error", (code, signal) => reject({ code, signal, stderr, stdout }));
  });
}

module.exports = {
  hasIntl,
  isDebug,
  isWindows,
  mustCall,
  mustCallAtLeast,
  mustNotCall,
  skip,
  expectWarning,
  invalidArgTypeHelper,
  spawnPromisified,
};
