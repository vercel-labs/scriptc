// @requires-libnode
// A class with no subclasses crossing into an island keeps its methods: the crossing has one
// class to pick and registers its method table the same way it does for a class that has
// subclasses.
import { requireModule } from "@scriptc/node";
import { Label } from "./classes.ts";

const island = requireModule("./island.mjs");
console.log("label:", island.show(new Label()));
