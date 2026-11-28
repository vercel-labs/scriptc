"use strict";
// @tsc-legacy-decorators
// Property decorators that return a descriptor: the truthy result is defined
// on the prototype, and an earlier-applied decorator receives it as its
// third argument, as tsc's `__decorate` chains the results.
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
function first(target, key, ...rest) {
    const result = rest[0];
    console.log("first sees", result === undefined ? "undefined" : typeof result.get);
}
function second() {
    console.log("factory second");
    return (target, key) => ({
        get: function () {
            return 42;
        },
        configurable: true,
    });
}
class C {
    x = 1;
}
__decorate([
    first,
    second()
], C.prototype, "x", void 0);
const descriptor = Object.getOwnPropertyDescriptor(C.prototype, "x");
console.log("proto getter", typeof descriptor?.get);
console.log("instance", new C().x);
