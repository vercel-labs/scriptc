// `switch` on a unit-typed discriminant: `switch (null)`,
// `switch (undefined)`, a null-typed binding, or a comma expression whose
// value is one of them. The IR has no standalone unit value, so the
// discriminant goes through the checked-dynamic path; every case test still
// evaluates in source order and Node's strict equality decides the match,
// so only a null or undefined test fires — `default` runs otherwise.

let outside = "outside";
var probeDefault;
switch (null) {
  default:
    let inside = "inside";
    probeDefault = function () {
      return inside;
    };
}
console.log("default-only:", probeDefault(), outside);

function pickNull(sel) {
  const log = [];
  switch (sel) {
    case (log.push("t1"), null):
      log.push("hit-null");
      break;
    case (log.push("t2"), null):
      log.push("hit-null-2");
      break;
    default:
      log.push("default");
  }
  return log.join(",");
}
console.log("null/null:", pickNull(null));

function pickUndefined(sel) {
  const log = [];
  switch (sel) {
    case (log.push("t1"), null):
      log.push("hit-null");
      break;
    case (log.push("t2"), undefined):
      log.push("hit-undefined");
      break;
    default:
      log.push("default");
  }
  return log.join(",");
}
console.log("undefined/null|undefined:", pickUndefined(undefined));

function pickUndefinedOnlyNullTest(sel) {
  const log = [];
  switch (sel) {
    case (log.push("t1"), null):
      log.push("hit-null");
      break;
    default:
      log.push("default");
  }
  return log.join(",");
}
console.log("undefined/null:", pickUndefinedOnlyNullTest(undefined));

function selectorOnce() {
  const log = [];
  switch ((log.push("selector"), null)) {
    case null:
      log.push("hit-null");
      break;
    default:
      log.push("default");
  }
  return log.join(",");
}
console.log("comma selector:", selectorOnce());

function aliasSource() {
  const value = null;
  const log = [];
  switch (value) {
    case null:
      log.push("hit-null");
      break;
    default:
      log.push("default");
  }
  return log.join(",");
}
console.log("binding:", aliasSource());
