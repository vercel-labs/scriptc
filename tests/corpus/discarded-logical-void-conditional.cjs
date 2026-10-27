// A discarded `a && b` / `a || b` whose right operand ends in a conditional
// over calls that return nothing, the shape minifiers emit for nested ifs.
const out = [];
function write(s) {
  out.push(s);
}

function digest(d) {
  null != d && (write("["), null == d ? write("null") : write(d));
}

function either(flag, other) {
  flag || (other ? write("other") : write("neither"));
}

function nested(a, b) {
  a && (write("a"), write("+"), b ? (write("b"), write("!")) : b === 0 ? write("zero") : write("none"));
}

digest("x");
digest(null);
digest(undefined);
either(true, true);
either(false, true);
either(false, false);
nested(1, 1);
nested(1, 0);
nested(1, "");
nested(0, 1);
console.log(out.join(" "));
