// A chalk-style builder: every style read through a function's runtime
// prototype chain runs a getter that creates a new callable builder,
// links it to a shared prototype with Object.setPrototypeOf, and caches
// it on the receiver with Object.defineProperty.
const GENERATOR = Symbol("GENERATOR");
const STYLER = Symbol("STYLER");
const IS_EMPTY = Symbol("IS_EMPTY");
const codes = { red: [31, 39], green: [32, 39], bold: [1, 22], underline: [4, 24] };
let getterRuns = 0;

const styles = Object.create(null);
for (const [name, [open, close]] of Object.entries(codes)) {
  styles[name] = {
    get() {
      getterRuns++;
      const builder = createBuilder(this, createStyler(`<${open}>`, `</${close}>`, this[STYLER]), this[IS_EMPTY]);
      Object.defineProperty(this, name, { value: builder });
      return builder;
    },
  };
}
styles.visible = {
  get() {
    const builder = createBuilder(this, this[STYLER], true);
    Object.defineProperty(this, "visible", { value: builder });
    return builder;
  },
};

const proto = Object.defineProperties(() => {}, {
  ...styles,
  level: {
    enumerable: true,
    get() {
      return this[GENERATOR].level;
    },
    set(level) {
      this[GENERATOR].level = level;
    },
  },
});

function createStyler(open, close, parent) {
  if (parent === undefined) return { open, close, openAll: open, closeAll: close, parent };
  return { open, close, openAll: parent.openAll + open, closeAll: close + parent.closeAll, parent };
}

function createBuilder(self, styler, isEmpty) {
  const builder = (...args) => applyStyle(builder, args.length === 1 ? "" + args[0] : args.join(" "));
  Object.setPrototypeOf(builder, proto);
  builder[GENERATOR] = self;
  builder[STYLER] = styler;
  builder[IS_EMPTY] = isEmpty;
  return builder;
}

function applyStyle(self, text) {
  if (self.level <= 0 || !text) return self[IS_EMPTY] ? "" : text;
  let styler = self[STYLER];
  if (styler === undefined) return text;
  const { openAll, closeAll } = styler;
  if (text.includes("</")) {
    for (; styler !== undefined; styler = styler.parent) text = replaceAll(text, styler.close, styler.close + styler.open);
  }
  return openAll + text + closeAll;
}

function replaceAll(text, search, replacement) {
  let index = text.indexOf(search);
  if (index === -1) return text;
  let out = "";
  let end = 0;
  do {
    out += text.slice(end, index) + replacement;
    end = index + search.length;
    index = text.indexOf(search, end);
  } while (index !== -1);
  return out + text.slice(end);
}

function createChalk(options) {
  const chalk = (...strings) => strings.join(" ");
  chalk.level = options && options.level !== undefined ? options.level : 1;
  Object.setPrototypeOf(chalk, createChalk.prototype);
  return chalk;
}
Object.setPrototypeOf(createChalk.prototype, Function.prototype);
Object.defineProperties(createChalk.prototype, styles);

const chalk = createChalk();
console.log(chalk.red("x"));
console.log(chalk.red.bold("nested"));
console.log(chalk.green("a " + chalk.red("b") + " c"));
console.log(chalk.underline.green.bold("three", "args", 3));
console.log(JSON.stringify(chalk.red("")), chalk.visible("v"), chalk.red.visible("rv"));
console.log(chalk("plain", "call"), typeof chalk, typeof chalk.red, typeof chalk.red.bold);
console.log(chalk.red === chalk.red, chalk.red.bold === chalk.red.bold, getterRuns);
console.log(Object.getPrototypeOf(chalk) === createChalk.prototype);
console.log(Object.getPrototypeOf(chalk.red) === proto, Object.getPrototypeOf(chalk.red.bold) === proto);
console.log(Object.getPrototypeOf(createChalk.prototype) === Function.prototype);
console.log(chalk.apply(null, ["via", "apply"]));
console.log(Object.keys(chalk).join(","), Object.hasOwn(chalk, "red"), "red" in chalk);

const red = chalk.red;
chalk.level = 0;
console.log(red("off"), red.level, chalk.level, JSON.stringify(red.visible("hidden")));
red.level = 2;
console.log(chalk.level, chalk.green.level, red("on"));
const quiet = createChalk({ level: 0 });
console.log(quiet.red.bold("quiet"), quiet.level, chalk.level);
