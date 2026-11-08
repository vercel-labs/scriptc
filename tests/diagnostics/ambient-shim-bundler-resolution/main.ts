// The ambient module re-exports a file the package's exports map does not
// list. This project resolves as a bundler does, so its own tsc reads the
// map, finds nothing, and reports the members as missing: so does every
// load of the build.
import { type CliCommand, commands, run } from "shapes-kit/cli";
import * as termCodes from "term-codes";

const first: CliCommand = commands[0];
console.log(commands.length, run(first.name), JSON.stringify(termCodes.eraseLine));
