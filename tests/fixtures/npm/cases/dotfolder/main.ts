// @dynamic
// A published CommonJS package can require a directory by its bare dot name.
import { ready, dot, parent } from "dotfolder";

const report: string = ready + ":" + dot + ":" + parent;
console.log(report);
