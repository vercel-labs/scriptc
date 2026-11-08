// chalk 4.1.0 (the real package and its dependencies, pinned in
// node_modules), compiled natively from its own JavaScript: a builder that
// is a function whose prototype is set to an object of style getters, an
// instance made by a class whose constructor returns the factory's
// function, a style table read through an accessor installed as the
// module's export object, and `constructor` replaced on a function. The
// named styles need no Node. The colour models (rgb, hex, keyword, hsl,
// ansi256, …) convert through color-convert, which ansi-styles requires
// the first time one is used: it ships no declarations, so it runs in a
// Node island that this call loads.
import chalk from "chalk";

const show = (label: string, value: string): void => {
  console.log(label + " " + JSON.stringify(value));
};

// Output is not a terminal here, so the default instance has level 0.
console.log("default level " + String(chalk.level) + " stderr " + String(chalk.stderr.level));
console.log("supportsColor " + JSON.stringify(chalk.supportsColor));
show("plain red", chalk.red("red"));
show("plain chain", chalk.bold.underline("x", "y", 3));

for (const level of [0, 1, 2, 3] as const) {
  const c = new chalk.Instance({ level });
  show(`L${level} red`, c.red("red"));
  show(`L${level} italic.yellow`, c.italic.yellow("seven of nine"));
  show(`L${level} multi`, c.green("one", "two", 3));
  show(`L${level} nested`, c.blue("a " + c.red("b") + " c"));
  show(`L${level} newline`, c.cyan.underline("line1\nline2\r\nline3"));
  show(`L${level} bg`, c.bgCyan.black("bg") + c.redBright.bgBlueBright("bright"));
  show(`L${level} modifiers`, c.italic.inverse.strikethrough("mods") + c.dim("d") + c.hidden("h"));
  show(`L${level} visible`, c.visible("v") + "|" + c.visible.red("r"));
  show(`L${level} rgb`, c.rgb(10, 20, 30)("rgb") + c.bgRgb(200, 100, 0)("bg"));
  show(`L${level} hex`, c.hex("#ff8800").bold("hex") + c.bgHex("#0f0")("bg"));
  show(`L${level} keyword`, c.keyword("orange")("kw") + c.bgKeyword("teal")("bg"));
  show(`L${level} hsl`, c.hsl(32, 100, 50)("hsl") + c.hsv(32, 100, 100)("hsv") + c.hwb(32, 0, 50)("hwb"));
  show(`L${level} ansi`, c.ansi(31)("ansi") + c.ansi256(201)("256") + c.bgAnsi256(17)("bg256"));
  show(`L${level} gray`, c.gray("x") + c.grey("y") + c.blackBright("z"));
  show(`L${level} empty`, c.red("") + "|" + c());
  show(`L${level} template`, c`plain {bold bold} {red.underline both} ${level}`);
  console.log(`L${level} level ${c.level} ${c.red.level} ${typeof c.red} ${typeof c.red.bold}`);
}

// A builder is cached on the object it was read from, and keeps the level
// of the instance it came from when that changes.
const mutable = new chalk.Instance({ level: 3 });
const red = mutable.red;
console.log("same builder " + String(mutable.red === red) + " " + String(red.bold === red.bold));
show("before", red("r"));
mutable.level = 0;
show("after level 0", red("r") + "|" + mutable.blue("b"));
mutable.level = 1;
show("after level 1", red.bgWhite("r"));

// Two instances do not share state.
const quiet = new chalk.Instance({ level: 0 });
const loud = new chalk.Instance({ level: 2 });
show("independent", quiet.yellow("q") + loud.yellow("l"));

// Errors a wrong level and the deprecated constructor throw.
try {
  new chalk.Instance({ level: 9 as 3 });
} catch (error) {
  console.log((error as Error).message);
}
try {
  (chalk.constructor as () => void)();
} catch (error) {
  console.log((error as Error).message);
}
