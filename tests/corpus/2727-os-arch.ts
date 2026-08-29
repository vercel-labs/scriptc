import { arch } from "node:os";
console.log(arch() === process.arch);
console.log(arch().length > 0);
console.log(arch());
