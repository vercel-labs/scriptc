function reached(flag) {
  if (flag) {
    function inner() {
      return "block";
    }
    return inner();
  }
  return typeof inner;
}

function beforeBlock() {
  var seen = typeof helper;
  {
    function helper() {
      return "helped";
    }
  }
  return seen + "/" + helper();
}

function afterBlock() {
  if (true) {
    function helper() {
      return "first";
    }
  } else {
    function helper() {
      return "second";
    }
  }
  return helper();
}

function looped() {
  var out = [];
  for (var i = 0; i < 2; i++) {
    if (i === 1) {
      function last() {
        return "last " + i;
      }
    }
    out.push(typeof last);
  }
  return out.join(",");
}

module.exports = { reached, beforeBlock, afterBlock, looped };
