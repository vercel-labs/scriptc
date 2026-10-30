import { installCount, useFormat, useScanner } from "./scanner.ts";

useScanner((bytes, start) => start + bytes.length * 2);
console.log("scanner installed");
const formatter = useFormat((value) => `[${value}]`);
console.log(formatter(7));
useScanner((bytes, start) => start);
console.log("installs", installCount());
