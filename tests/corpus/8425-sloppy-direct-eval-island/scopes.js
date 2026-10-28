function readsLocal() {
  var local = "seen";
  return eval("local");
}

function writesLocal() {
  var local = 41;
  eval("local = local + 1");
  return local;
}

function declaresInFunction() {
  eval('var fromEval = "declared";');
  return typeof fromEval + "/" + fromEval;
}

var globalName = "module scope";

function declaresAtTopLevel() {
  return eval("globalName");
}

function seesArgument(value) {
  return eval("value + '!'");
}

function repeated() {
  var total = 0;
  for (var i = 1; i <= 3; i++) {
    eval("total = total + i");
  }
  return total;
}

module.exports = {
  readsLocal,
  writesLocal,
  declaresInFunction,
  declaresAtTopLevel,
  seesArgument,
  repeated,
};
