// @requires-libnode
// A shared module whose only exports are functions, one of them rebound:
// the island calls the hoisted function while the cycle has not evaluated
// core's body, and after `retitle()` reassigns it the island's live binding
// must answer the new function. Node prints `early early early` then
// `early late late`.
import { retitle, snapshot } from "core";
console.log(snapshot());
retitle();
console.log(snapshot());
