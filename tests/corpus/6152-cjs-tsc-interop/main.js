"use strict";
// tsc's CommonJS output: interop helpers over require(), the void 0
// preamble, and the (0, x.default)() call spelling.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = void 0;
console.log("main: start");
const plain_1 = __importDefault(require("./plain.js"));
const stamped_1 = __importDefault(require("./stamped.js"));
const fn_1 = __importDefault(require("./fn.js"));
function run() {
    return [plain_1.default.greet("a"), (0, stamped_1.default)("b"), stamped_1.helper(), (0, fn_1.default)(2)].join(" ");
}
exports.run = run;
console.log(run(), plain_1.default.count, typeof fn_1.default);
