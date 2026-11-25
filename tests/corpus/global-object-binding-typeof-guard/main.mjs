// A module reads a global-object property another module wrote, through the
// feature-detection guards whose typeof answer folded as if the name were
// absent: the answer Node gives is the runtime global object's, even though
// nothing in this module's source names the property.
import { installDetector } from "./install.mjs";

if (typeof Detector === "function") console.log("guarded then");
else console.log("guarded else");
console.log(typeof Detector === "function", typeof Detector === "undefined");

installDetector();

if (typeof Detector === "function") console.log("installed then");
else console.log("installed else");
if (typeof Detector !== "undefined") console.log("defined");
else console.log("absent");
console.log(typeof Detector === "function" && Detector() === "detected");
console.log(typeof Detector === "function" ? "then arm" : "else arm");
console.log(typeof Detector === "" || typeof Detector < "u");
