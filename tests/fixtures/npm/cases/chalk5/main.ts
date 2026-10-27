// chalk 5 (the real package, pinned in node_modules): the callable
// builder whose styles are prototype getters on a function chain, every
// color model, nested styles, chalk.level and new Chalk({ level }) at all
// four levels. chalk.test.ts runs the same program under FORCE_COLOR and
// the --color flags.
import chalk, { Chalk, chalkStderr, supportsColor, modifierNames, foregroundColorNames, backgroundColorNames, colorNames } from "chalk";

const show = (label: string, value: string): void => {
  console.log(label + " " + JSON.stringify(value));
};

console.log("default level " + String(chalk.level) + " stderr " + String(chalkStderr.level));
console.log("supportsColor " + JSON.stringify(supportsColor));
console.log(modifierNames.join(","));
console.log(foregroundColorNames.length + " " + backgroundColorNames.length + " " + colorNames.length);

show("red", chalk.red("red"));
// Root members named like String.prototype's HTML methods, called from
// TypeScript (pi's `chalk.bold(APP_NAME)`): the checker types chalk's
// JavaScript default export as a plain function, so the member is `any`.
show("bold", chalk.bold("bold"));
show("bold template", `${chalk.bold("Usage:")} pi`);
const alias = chalk;
show("bold alias", alias.bold("alias") + alias.italic("i"));
show("red.bold", chalk.red.bold("bold red"));
show("nested", chalk.blue("a " + chalk.red("b") + " c"));
show("multi-arg", chalk.green("one", "two", 3));
show("number", chalk.yellow(42 as unknown as string));
show("empty", chalk.red(""));
show("newline", chalk.magenta.underline("line1\nline2\r\nline3"));
show("bg", chalk.bgCyan.black("bg"));
show("bright", chalk.redBright.bgBlueBright("bright"));
show("modifiers", chalk.italic.inverse.strikethrough.overline("mods"));
show("hidden-visible", chalk.hidden("h") + "|" + chalk.visible("v"));
show("rgb", chalk.rgb(10, 20, 30)("rgb"));
show("hex", chalk.hex("#ff8800").bold("hex"));
show("hex-short", chalk.bgHex("#0f0")("bg hex"));
show("ansi256", chalk.ansi256(201)("ansi256"));
show("bgAnsi256", chalk.bgAnsi256(17).white("bgAnsi256"));
show("callable", chalk("plain", "args"));
show("gray-grey", chalk.gray("x") + chalk.grey("y"));

for (const level of [0, 1, 2, 3] as const) {
  const c = new Chalk({ level });
  show(`L${level} red.bold`, c.red.bold("x"));
  show(`L${level} bold`, c.bold("x"));
  show(`L${level} hex`, c.hex("#123456")("x"));
  show(`L${level} rgb`, c.rgb(255, 255, 255).bgRgb(0, 0, 0)("x"));
  show(`L${level} ansi256`, c.ansi256(100).bgAnsi256(200)("x"));
  show(`L${level} visible`, c.visible.red("v"));
  show(`L${level} nested`, c.green("g" + c.yellow("y") + "g"));
}

const mutable = new Chalk({ level: 3 });
const red = mutable.red;
show("before", red("r"));
mutable.level = 0;
show("after level 0", red("r") + "|" + mutable.blue("b"));
console.log("level via builder " + String(red.level));
red.level = 2;
console.log("shared level " + String(mutable.level));
show("restored", mutable.cyan("c"));

try {
  new Chalk({ level: 5 as 0 });
} catch (error) {
  console.log("error " + (error as Error).message);
}

chalk.level = 1;
show("global after set", chalk.red.bold("x"));
console.log("global level " + String(chalk.level));
