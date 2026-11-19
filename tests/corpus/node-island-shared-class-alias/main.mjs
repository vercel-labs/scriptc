// @requires-libnode
// A shared module that binds another module's classes locally
// (`export const Base = C.Base`) registers their method tables (NI-6):
// island code reads their accessors and methods and answers instanceof
// for instances made on either side.
import { requireModule } from "@scriptc/node";
import { Base, Derived, instance, baseInstance } from "./shared.ts";

const island = requireModule("./island.mjs");

const derived = new Derived();
console.log("native:", derived.x, derived.m(), derived instanceof Base);
console.log("shared instances:", instance.x, instance.m(), baseInstance.x, baseInstance.m());
console.log("island reads:", island.check());
console.log("island reads base:", island.base());
console.log("island constructs derived:", island.made());
console.log("island constructs base:", island.madeBase());
