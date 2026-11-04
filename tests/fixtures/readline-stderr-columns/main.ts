/* A prompt that crosses the terminal row on a stderr output: readline's
 * columns are the output descriptor's, so the refresh after writing the
 * prompt asks for the wrapped column, as Node does. */
import * as readline from "node:readline";
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stderr,
  prompt: "0123456789".repeat(5) + "> ",
});
rl.prompt();
rl.close();
