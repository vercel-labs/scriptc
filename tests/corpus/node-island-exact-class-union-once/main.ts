// @requires-libnode
// A method value an island calls returns its class-typed result with the class it has at run
// time, and the result is read once: a method that answers an object once and then null (a
// consuming lookup) must not have its second call narrowed where the first call's object was
// expected.
import { requireModule } from "@scriptc/node";
import { Drain, Queue } from "./classes.ts";

const island = requireModule("./island.mjs");
const queue: Queue = new Drain();
console.log("drain:", island.drain(queue));
const leftover = queue.take();
console.log("leftover:", leftover === null);
