import { Command } from "commander";

const program = new Command();
program.version("1.2.3");
console.log(program.version());
