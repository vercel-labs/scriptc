// A module whose whole export a condition chooses, with members attached to
// the value that branch stored. Node's require answers that value, with the
// members the branch attached; a member read through the require result and
// a member the module itself reads back both see them.
const exit = require("./exit.cjs");
console.log(exit("ready"), exit.unload(), exit.signals().join(","));

const settings = require("./settings.cjs");
console.log(settings.format, settings.read(), settings.constructor === Object);
