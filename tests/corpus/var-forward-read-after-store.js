// A `var` read by functions declared ABOVE it. Node gives those functions the
// value its declaration stored, because every call runs after that store; the
// binding's type excludes undefined, so the hoisted slot is never observed
// empty. The chain of readers (one function calling another) settles through
// the names they are called by.
"use strict";

(function () {
  function describe(type) {
    return type === ELEMENT_TYPE ? "<element>" : isLazy(type) ? "<lazy>" : "<other>";
  }
  function isLazy(type) {
    return type === LAZY_TYPE;
  }
  var ELEMENT_TYPE = Symbol.for("example.element"),
    LAZY_TYPE = Symbol.for("example.lazy");
  console.log(describe(ELEMENT_TYPE), describe(LAZY_TYPE), describe(Symbol.for("x")));
})();

// The same shape declared inside a block: the function above the block's
// declaration still runs only after it.
(function () {
  function show() {
    return tag;
  }
  if (Math.random() > 2) {
    var tag = "unreachable";
  }
  var tag = "block";
  console.log(show());
})();
