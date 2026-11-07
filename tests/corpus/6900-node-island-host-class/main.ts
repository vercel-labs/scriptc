// @requires-libnode
// socket.ts extends a host class the program only declares, and only Node
// has the class itself: the module runs in a Node island automatically
// (R1.6) while the entry stays native.
import { describeSocket } from "./socket.ts";

console.log("socket:", describeSocket());
