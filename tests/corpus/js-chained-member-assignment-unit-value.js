// @deferred-fences: 1
"use strict";

// A chained member assignment in a JavaScript file: the value the chain
// yields is held in a temporary, and here that value is `null` — a bare unit
// type no local can hold. The pattern is asap's flush guard
// (`domain.active = process.domain = null`): nothing sets process.domain in
// this program, so the write never executes, but the function still has to
// lower and the chain still has to yield null. Writing a property that
// `process` does not declare is a runtime fence (SC1090), which is the one
// deferred site: the chain reaches the temporary only through a receiver
// like `process`, so the program keeps asap's spelling.
var domain;

function requestFlush(parentDomain) {
  if (parentDomain) {
    domain.active = process.domain = null;
  }
  console.log("flush");
}

requestFlush(undefined);
requestFlush(null);
