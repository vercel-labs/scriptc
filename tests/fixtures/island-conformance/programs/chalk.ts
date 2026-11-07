import chalk, { Chalk } from "chalk";

const forced = new Chalk({ level: 1 });
console.log(JSON.stringify(forced.red.bold("alert")), JSON.stringify(forced.bgBlue.white(" ok ")));
console.log(typeof chalk.green, typeof forced.red.bold, forced.underline("x").length);
console.log(JSON.stringify(new Chalk({ level: 3 }).hex("#ff8800")("deep")), new Chalk({ level: 0 }).red("plain"));
