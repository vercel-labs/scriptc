// A polyfill spelled `X.m = X.m || f` assigns: the member's own value. Where
// the member is writable nothing changes, and in sloppy code, which this
// script is, an assignment to a read-only member or to a member of a frozen
// object does nothing either. `X.m ||= f` and `X.m ??= f` over a member that
// is there never assign.
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
