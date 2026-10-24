// A package that scriptc implements at some major versions (chalk 5)
// compiles from its own source at a version without an implementation.
import chalk, { level } from "chalk";

console.log(chalk.version, level, chalk.red("red"), chalk.bold("bold"));
