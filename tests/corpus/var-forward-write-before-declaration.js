// A forward WRITE: the binding is stored above its `var` statement, so the
// reader declared above sees that value until the declaration's own
// initializer replaces it. The slot starts empty; both stores fill it.
"use strict";

function setup(flag) {
  function read() {
    return mode;
  }
  mode = flag ? "on" : "off";
  console.log("stored early:", read());
  var mode = flag ? "A" : "B";
  console.log("after declaration:", read());
}
setup(true);
setup(false);
