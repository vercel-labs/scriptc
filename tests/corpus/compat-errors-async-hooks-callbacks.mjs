// createHook validates each callback it is given: a member that is not a
// function is ERR_ASYNC_CALLBACK naming the member.
import { createHook } from "node:async_hooks";

function show(label, fn) {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
}

show("init", () => createHook({ init: 5 }));
show("before", () => createHook({ before: "x" }));
show("destroy", () => createHook({ destroy: true }));
show("promiseResolve", () => createHook({ promiseResolve: null }));
