// A polyfill spelled `X.m = X.m || f` assigns: the member's own value. Where
// the member is writable nothing changes. A read-only member, or any member
// of a frozen object, makes the assignment a TypeError in strict code, which
// a module is. `X.m ||= f` and `X.m ??= f` over a member that is there never
// assign, so they throw nowhere.
function attempt(label, write) {
  try {
    write();
    console.log(label, "no error");
  } catch (e) {
    console.log(label, "threw", e instanceof TypeError);
  }
}

attempt("writable ||", () => {
  Array.prototype.at =
    Array.prototype.at ||
    function () {
      return undefined;
    };
});
attempt("writable ??", () => {
  Array.prototype.at =
    Array.prototype.at ??
    function () {
      return undefined;
    };
});
attempt("writable =", () => {
  Array.prototype.at = Array.prototype.at;
});
attempt("read-only ||", () => {
  Math.PI = Math.PI || 3;
});
attempt("read-only ??", () => {
  Math.PI = Math.PI ?? 3;
});
attempt("read-only =", () => {
  Math.PI = Math.PI;
});
attempt("read-only ||=", () => {
  Math.PI ||= 3;
});
attempt("read-only ??=", () => {
  Math.PI ??= 3;
});

Object.freeze(Math);
attempt("frozen ||", () => {
  Math.max =
    Math.max ||
    function () {
      return 0;
    };
});
attempt("frozen ??", () => {
  Math.max =
    Math.max ??
    function () {
      return 0;
    };
});
attempt("frozen =", () => {
  Math.max = Math.max;
});
attempt("frozen ||=", () => {
  Math.max ||= function () {
    return 0;
  };
});
attempt("frozen ??=", () => {
  Math.max ??= function () {
    return 0;
  };
});

console.log([1, 2, 3].at(-1), Math.PI.toFixed(2), Math.max(1, 2));
