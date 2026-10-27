// A CommonJS module exporting a function that carries its own members
// (statuses' `status.message = codes; module.exports = status`), read from
// TypeScript through the default import: calls, member reads, member calls.
import status from "./status.cjs";
import { describe } from "./consumer.cjs";

console.log(status(404), status.message[200], status.codes.length, status.isOk(200));
console.log(status.redirect[301] === true, status.redirect[302]);
console.log(describe(500));
