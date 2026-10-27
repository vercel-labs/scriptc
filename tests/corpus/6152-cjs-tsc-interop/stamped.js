"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.helper = exports.default = void 0;
console.log("stamped: evaluated");
function greet(who) {
    return "stamped " + who;
}
exports.default = greet;
function helper() {
    return "helper";
}
exports.helper = helper;
