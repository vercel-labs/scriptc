// chalk 5 builders used as values (the package compiles from scriptc's
// built-in shim): builders in function slots and arrays, styles picked at
// run time, builders in record fields called with any number of arguments,
// visible at level 0, chalkStderr, and the root's own call.
import chalk, { Chalk, chalkStderr, type ChalkInstance, type ForegroundColorName } from "chalk";

const show = (label: string, value: string): void => {
  console.log(label + " " + JSON.stringify(value));
};

const c = new Chalk({ level: 1 });
const paint: (text: string) => string = c.green;
show("slot", paint("go"));
const styles: ChalkInstance[] = [c.red, c.bold, c.underline.blue];
show("array", styles.map((style) => style("x")).join("|"));
const byName = (name: ForegroundColorName): ChalkInstance => {
  switch (name) {
    case "red":
      return c.red;
    case "green":
      return c.green;
    default:
      return c.white;
  }
};
show("picked", byName("red")("r") + byName("green")("g") + byName("cyan")("w"));
let chain: ChalkInstance = c;
for (const step of ["bold", "italic", "yellow"]) {
  chain = step === "bold" ? chain.bold : step === "italic" ? chain.italic : chain.yellow;
}
show("built", chain("chain"));
show("cached", c.red === c.red ? "same" : "different");
show("nested close", c.red("a" + c.blue("b") + "c" + c.red("d") + "e"));
show("bg nested", c.bgRed("a" + c.bgBlue("b") + "c"));

const off = new Chalk({ level: 0 });
show("visible off", off.visible("v") + "|" + off.red.visible("v") + "|" + off.red("plain"));
show("root call", c("a", 1, true) + "|" + c() + "|" + c(undefined) + "|" + c(null, "n"));
show("builder args", c.red(undefined) + "|" + c.red(null) + "|" + c.red(1, 2) + "|" + c.red());
const theme = { error: c.red, note: c.bold.blue };
show("field args", theme.error("a", "b") + "|" + theme.note("x", 1, true) + "|" + theme.error("one") + "|" + theme.error());
show("multiline", c.cyan("one\r\ntwo\nthree"));
show("stderr level", String(chalkStderr.level >= 0));
show("rgb levels", [1, 2, 3].map((level) => new Chalk({ level: level as 1 | 2 | 3 }).rgb(255, 136, 0)("o")).join("|"));
show("hex bg", new Chalk({ level: 2 }).bgHex("#abcdef")("h") + new Chalk({ level: 1 }).bgHex("123")("i"));
c.level = 0;
show("after level 0", paint("go") + "|" + c.red("r"));
show("default red", chalk.level >= 0 ? "ok" : "bad");
