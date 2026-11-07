// Typed use of a package's callable-with-properties export.
import createDebug from "fnlib";
const log = createDebug("app");
console.log(log("start"), log.namespace, createDebug.enabled);
createDebug.prefix = "* ";
console.log(log("again"), Object.keys(createDebug));
