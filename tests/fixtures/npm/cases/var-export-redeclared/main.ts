// An importer sees the value module.exports holds, not the redeclared binding.
import { ns } from "redeclared-ns";
console.log(ns.version);
