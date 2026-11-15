// @requires-libnode
// A function the island hands out under a types-only package's callable
// type (`express.json(): NextHandleFunction`, whose parameters are Node
// message types): the handle is a function object the island made, so it
// crosses back in and is used there instead of becoming a native value.
import { json, accept } from "bodyish";

console.log(accept(json()));
