// scriptc's built-in implementation of the `chalk` package, 5.x API.
//
// Programs whose installed chalk is 5.x compile this module in its place
// (packages/compiler/src/frontend/package-shims.ts). chalk builds its
// styles as functions whose prototypes it swaps at run time; here a style
// chain is an instance of one class whose style members are cached
// getters, and the instance is callable through its `%call` field (the
// merged interface below gives it chalk's call signature; the lowerer calls
// the field). The output, color-level detection (supports-color 10:
// FORCE_COLOR, the --color/--no-color flags, TTY, TERM, CI variables) and
// the shared, settable `level` follow chalk 5.6 byte for byte.
import * as os from "node:os";
import * as tty from "node:tty";

export type ColorSupportLevel = 0 | 1 | 2 | 3;

export interface ColorSupport {
  level: ColorSupportLevel;
  hasBasic: boolean;
  has256: boolean;
  has16m: boolean;
}

export type ColorInfo = ColorSupport | false;

export interface Options {
  readonly level?: ColorSupportLevel;
}

export type ModifierName =
  | "reset"
  | "bold"
  | "dim"
  | "italic"
  | "underline"
  | "overline"
  | "inverse"
  | "hidden"
  | "strikethrough";

export type ForegroundColorName =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "cyan"
  | "magenta"
  | "white"
  | "gray"
  | "grey"
  | "blackBright"
  | "redBright"
  | "greenBright"
  | "yellowBright"
  | "blueBright"
  | "cyanBright"
  | "magentaBright"
  | "whiteBright";

export type BackgroundColorName =
  | "bgBlack"
  | "bgRed"
  | "bgGreen"
  | "bgYellow"
  | "bgBlue"
  | "bgCyan"
  | "bgMagenta"
  | "bgWhite"
  | "bgGray"
  | "bgGrey"
  | "bgBlackBright"
  | "bgRedBright"
  | "bgGreenBright"
  | "bgYellowBright"
  | "bgBlueBright"
  | "bgCyanBright"
  | "bgMagentaBright"
  | "bgWhiteBright";

export type ColorName = ForegroundColorName | BackgroundColorName;

export type Modifiers = ModifierName;
export type ForegroundColor = ForegroundColorName;
export type BackgroundColor = BackgroundColorName;
export type Color = ColorName;

// ── ansi-styles ──────────────────────────────────────────────────────────

export const modifierNames: ModifierName[] = [
  "reset",
  "bold",
  "dim",
  "italic",
  "underline",
  "overline",
  "inverse",
  "hidden",
  "strikethrough",
];
export const foregroundColorNames: ForegroundColorName[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "blackBright",
  "gray",
  "grey",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "whiteBright",
];
export const backgroundColorNames: BackgroundColorName[] = [
  "bgBlack",
  "bgRed",
  "bgGreen",
  "bgYellow",
  "bgBlue",
  "bgMagenta",
  "bgCyan",
  "bgWhite",
  "bgBlackBright",
  "bgGray",
  "bgGrey",
  "bgRedBright",
  "bgGreenBright",
  "bgYellowBright",
  "bgBlueBright",
  "bgMagentaBright",
  "bgCyanBright",
  "bgWhiteBright",
];
export const colorNames: ColorName[] = [...foregroundColorNames, ...backgroundColorNames];
export const modifiers: Modifiers[] = modifierNames;
export const foregroundColors: ForegroundColor[] = foregroundColorNames;
export const backgroundColors: BackgroundColor[] = backgroundColorNames;
export const colors: Color[] = colorNames;

const ESC = "\u001B[";

/** Open and close codes, indexed by style id (the order of the getters). */
const OPEN_CODES: number[] = [
  0, 1, 2, 3, 4, 53, 7, 8, 9, 30, 31, 32, 33, 34, 35, 36, 37, 90, 90, 90, 91, 92, 93, 94, 95, 96,
  97, 40, 41, 42, 43, 44, 45, 46, 47, 100, 100, 100, 101, 102, 103, 104, 105, 106, 107,
];
const CLOSE_CODES: number[] = [
  0, 22, 22, 23, 24, 55, 27, 28, 29, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39, 39,
  39, 39, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49, 49,
];
const VISIBLE = 45;

function rgbToAnsi256(red: number, green: number, blue: number): number {
  if (red === green && green === blue) {
    if (red < 8) return 16;
    if (red > 248) return 231;
    return Math.round(((red - 8) / 247) * 24) + 232;
  }
  return (
    16 +
    36 * Math.round((red / 255) * 5) +
    6 * Math.round((green / 255) * 5) +
    Math.round((blue / 255) * 5)
  );
}

function hexToRgb(hex: string): number[] {
  const matches = /[a-f\d]{6}|[a-f\d]{3}/i.exec(hex);
  if (matches === null) return [0, 0, 0];
  let colorString = matches[0];
  if (colorString.length === 3) {
    let doubled = "";
    for (const character of colorString) doubled += character + character;
    colorString = doubled;
  }
  const integer = Number.parseInt(colorString, 16);
  return [(integer >> 16) & 0xff, (integer >> 8) & 0xff, integer & 0xff];
}

function ansi256ToAnsi(code: number): number {
  if (code < 8) return 30 + code;
  if (code < 16) return 90 + (code - 8);
  let red: number;
  let green: number;
  let blue: number;
  if (code >= 232) {
    red = ((code - 232) * 10 + 8) / 255;
    green = red;
    blue = red;
  } else {
    code -= 16;
    const remainder = code % 36;
    red = Math.floor(code / 36) / 5;
    green = Math.floor(remainder / 6) / 5;
    blue = (remainder % 6) / 5;
  }
  const value = Math.max(red, green, blue) * 2;
  if (value === 0) return 30;
  let result = 30 + ((Math.round(blue) << 2) | (Math.round(green) << 1) | Math.round(red));
  if (value === 2) result += 60;
  return result;
}

/** The open code of a color model at a level: offset 0 is the foreground,
 * 10 the background (ansi-styles' wrapAnsi16/256/16m). */
function rgbOpen(level: number, offset: number, red: number, green: number, blue: number): string {
  if (level === 3) return `${ESC}${38 + offset};2;${red};${green};${blue}m`;
  if (level === 2) return `${ESC}${38 + offset};5;${rgbToAnsi256(red, green, blue)}m`;
  return `${ESC}${ansi256ToAnsi(rgbToAnsi256(red, green, blue)) + offset}m`;
}

/** chalk's ansi256 model emits the 256-color code at every level (only
 * the rgb and hex models downsample). */
function ansi256Open(offset: number, code: number): string {
  return `${ESC}${38 + offset};5;${code}m`;
}

// ── supports-color ───────────────────────────────────────────────────────

function hasFlag(flag: string): boolean {
  const argv = process.argv;
  const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
  const position = argv.indexOf(prefix + flag);
  const terminatorPosition = argv.indexOf("--");
  return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
}

let flagForceColor: number | undefined = undefined;
if (
  hasFlag("no-color") ||
  hasFlag("no-colors") ||
  hasFlag("color=false") ||
  hasFlag("color=never")
) {
  flagForceColor = 0;
} else if (
  hasFlag("color") ||
  hasFlag("colors") ||
  hasFlag("color=true") ||
  hasFlag("color=always")
) {
  flagForceColor = 1;
}

function envForceColor(): number | undefined {
  const force = process.env["FORCE_COLOR"];
  if (force !== undefined) {
    if (force === "true") return 1;
    if (force === "false") return 0;
    return force.length === 0 ? 1 : Math.min(Number.parseInt(force, 10), 3);
  }
  return undefined;
}

function translateLevel(level: number): ColorInfo {
  if (level === 0) return false;
  return {
    level: level as ColorSupportLevel,
    hasBasic: true,
    has256: level >= 2,
    has16m: level >= 3,
  };
}

function inEnv(name: string): boolean {
  return process.env[name] !== undefined;
}

function detectLevel(streamIsTTY: boolean): number {
  const noFlagForceColor = envForceColor();
  if (noFlagForceColor !== undefined) flagForceColor = noFlagForceColor;
  const forceColor = flagForceColor;
  if (forceColor === 0) return 0;
  if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) return 3;
  if (hasFlag("color=256")) return 2;
  if (inEnv("TF_BUILD") && inEnv("AGENT_NAME")) return 1;
  if (!streamIsTTY && forceColor === undefined) return 0;
  const min =
    forceColor === undefined || forceColor === 0 || Number.isNaN(forceColor) ? 0 : forceColor;
  const env = process.env;
  const term = env["TERM"];
  if (term === "dumb") return min;
  if (process.platform === "win32") {
    const osRelease = os.release().split(".");
    if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10_586) {
      return Number(osRelease[2]) >= 14_931 ? 3 : 2;
    }
    return 1;
  }
  if (inEnv("CI")) {
    if (inEnv("GITHUB_ACTIONS") || inEnv("GITEA_ACTIONS") || inEnv("CIRCLECI")) return 3;
    if (
      inEnv("TRAVIS") ||
      inEnv("APPVEYOR") ||
      inEnv("GITLAB_CI") ||
      inEnv("BUILDKITE") ||
      inEnv("DRONE") ||
      env["CI_NAME"] === "codeship"
    ) {
      return 1;
    }
    return min;
  }
  const teamcity = env["TEAMCITY_VERSION"];
  if (teamcity !== undefined) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(teamcity) ? 1 : 0;
  }
  if (env["COLORTERM"] === "truecolor") return 3;
  if (term === "xterm-kitty") return 3;
  if (term === "xterm-ghostty") return 3;
  if (term === "wezterm") return 3;
  const termProgram = env["TERM_PROGRAM"];
  if (termProgram !== undefined) {
    const version = Number.parseInt((env["TERM_PROGRAM_VERSION"] || "").split(".")[0]!, 10);
    if (termProgram === "iTerm.app") return version >= 3 ? 3 : 2;
    if (termProgram === "Apple_Terminal") return 2;
  }
  // supports-color tests these against `env.TERM`, which is the string
  // "undefined" when TERM is unset.
  const termText = term === undefined ? "undefined" : term;
  if (/-256(color)?$/i.test(termText)) return 2;
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(termText)) return 1;
  if (inEnv("COLORTERM")) return 1;
  return min;
}

const stdoutColor: ColorInfo = translateLevel(detectLevel(tty.isatty(1)));
const stderrColor: ColorInfo = translateLevel(detectLevel(tty.isatty(2)));

export const supportsColor: ColorInfo = stdoutColor;
export const supportsColorStderr: ColorInfo = stderrColor;

// ── the builder ──────────────────────────────────────────────────────────

/** One link of a style chain (chalk's styler). */
class Styler {
  open: string;
  close: string;
  openAll: string;
  closeAll: string;
  parent: Styler | undefined;
  constructor(open: string, close: string, parent: Styler | undefined) {
    this.open = open;
    this.close = close;
    this.parent = parent;
    if (parent === undefined) {
      this.openAll = open;
      this.closeAll = close;
    } else {
      this.openAll = parent.openAll + open;
      this.closeAll = close + parent.closeAll;
    }
  }
}

/** The level every builder of one chalk instance shares. */
class LevelBox {
  level: number;
  constructor(level: number) {
    this.level = level;
  }
}

function stringReplaceAll(string: string, substring: string, replacer: string): string {
  let index = string.indexOf(substring);
  if (index === -1) return string;
  const substringLength = substring.length;
  let endIndex = 0;
  let returnValue = "";
  do {
    returnValue += string.slice(endIndex, index) + substring + replacer;
    endIndex = index + substringLength;
    index = string.indexOf(substring, endIndex);
  } while (index !== -1);
  returnValue += string.slice(endIndex);
  return returnValue;
}

function stringEncaseCRLFWithFirstIndex(
  string: string,
  prefix: string,
  postfix: string,
  index: number,
): string {
  let endIndex = 0;
  let returnValue = "";
  do {
    const gotCR = string[index - 1] === "\r";
    returnValue +=
      string.slice(endIndex, gotCR ? index - 1 : index) +
      prefix +
      (gotCR ? "\r\n" : "\n") +
      postfix;
    endIndex = index + 1;
    index = string.indexOf("\n", endIndex);
  } while (index !== -1);
  returnValue += string.slice(endIndex);
  return returnValue;
}

function applyStyle(self: ChalkInstance, string: string): string {
  if (self.box.level <= 0 || !string) return self.isEmpty ? "" : string;
  let styler = self.styler;
  if (styler === undefined) return string;
  const openAll = styler.openAll;
  const closeAll = styler.closeAll;
  if (string.includes("\u001B")) {
    while (styler !== undefined) {
      string = stringReplaceAll(string, styler.close, styler.open);
      styler = styler.parent;
    }
  }
  const lfIndex = string.indexOf("\n");
  if (lfIndex !== -1) string = stringEncaseCRLFWithFirstIndex(string, closeAll, openAll, lfIndex);
  return openAll + string + closeAll;
}

function joinArguments(args: unknown[]): string {
  let out = "";
  for (let i = 0; i < args.length; i++) {
    if (i > 0) out += " ";
    const value = args[i];
    if (value !== undefined && value !== null) out += String(value);
  }
  return out;
}

/** A chalk instance or one of its style chains: callable (chalk's call
 * signature merges in from the interface), with every style a cached
 * getter. */
// The merge is the point: the interface gives instances chalk's call
// signature, and the class's `%call` field implements it.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export interface ChalkInstance {
  (...text: unknown[]): string;
}

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export class ChalkInstance {
  "%call": (...text: unknown[]) => string = (...text: unknown[]): string =>
    this.root
      ? joinArguments(text)
      : applyStyle(this, text.length === 1 ? "" + String(text[0]) : joinArguments(text));
  box: LevelBox;
  styler: Styler | undefined;
  isEmpty: boolean;
  private readonly root: boolean;
  private readonly cache: (ChalkInstance | undefined)[] = [];

  constructor(box: LevelBox, styler: Styler | undefined, isEmpty: boolean, root: boolean) {
    this.box = box;
    this.styler = styler;
    this.isEmpty = isEmpty;
    this.root = root;
  }

  /** One string argument: the compiler calls this instead of `%call`
   * (no variadic arguments to box). */
  "%call1"(text: string): string {
    return this.root ? text : applyStyle(this, text);
  }

  get level(): ColorSupportLevel {
    return this.box.level as ColorSupportLevel;
  }

  set level(level: ColorSupportLevel) {
    this.box.level = level;
  }

  private style(id: number): ChalkInstance {
    const cached = this.cache[id];
    if (cached !== undefined) return cached;
    let builder: ChalkInstance;
    if (id === VISIBLE) {
      builder = new ChalkInstance(this.box, this.styler, true, false);
    } else {
      const styler = new Styler(
        `${ESC}${OPEN_CODES[id]!}m`,
        `${ESC}${CLOSE_CODES[id]!}m`,
        this.styler,
      );
      builder = new ChalkInstance(this.box, styler, this.isEmpty, false);
    }
    while (this.cache.length <= id) this.cache.push(undefined);
    this.cache[id] = builder;
    return builder;
  }

  private model(open: string, background: boolean): ChalkInstance {
    const styler = new Styler(open, background ? `${ESC}49m` : `${ESC}39m`, this.styler);
    return new ChalkInstance(this.box, styler, this.isEmpty, false);
  }

  rgb(red: number, green: number, blue: number): ChalkInstance {
    return this.model(rgbOpen(this.box.level, 0, red, green, blue), false);
  }
  hex(color: string): ChalkInstance {
    const [red, green, blue] = hexToRgb(color);
    return this.model(rgbOpen(this.box.level, 0, red!, green!, blue!), false);
  }
  ansi256(index: number): ChalkInstance {
    return this.model(ansi256Open(0, index), false);
  }
  bgRgb(red: number, green: number, blue: number): ChalkInstance {
    return this.model(rgbOpen(this.box.level, 10, red, green, blue), true);
  }
  bgHex(color: string): ChalkInstance {
    const [red, green, blue] = hexToRgb(color);
    return this.model(rgbOpen(this.box.level, 10, red!, green!, blue!), true);
  }
  bgAnsi256(index: number): ChalkInstance {
    return this.model(ansi256Open(10, index), true);
  }

  get reset(): ChalkInstance {
    return this.style(0);
  }
  get bold(): ChalkInstance {
    return this.style(1);
  }
  get dim(): ChalkInstance {
    return this.style(2);
  }
  get italic(): ChalkInstance {
    return this.style(3);
  }
  get underline(): ChalkInstance {
    return this.style(4);
  }
  get overline(): ChalkInstance {
    return this.style(5);
  }
  get inverse(): ChalkInstance {
    return this.style(6);
  }
  get hidden(): ChalkInstance {
    return this.style(7);
  }
  get strikethrough(): ChalkInstance {
    return this.style(8);
  }
  get visible(): ChalkInstance {
    return this.style(VISIBLE);
  }
  get black(): ChalkInstance {
    return this.style(9);
  }
  get red(): ChalkInstance {
    return this.style(10);
  }
  get green(): ChalkInstance {
    return this.style(11);
  }
  get yellow(): ChalkInstance {
    return this.style(12);
  }
  get blue(): ChalkInstance {
    return this.style(13);
  }
  get magenta(): ChalkInstance {
    return this.style(14);
  }
  get cyan(): ChalkInstance {
    return this.style(15);
  }
  get white(): ChalkInstance {
    return this.style(16);
  }
  get blackBright(): ChalkInstance {
    return this.style(17);
  }
  get gray(): ChalkInstance {
    return this.style(18);
  }
  get grey(): ChalkInstance {
    return this.style(19);
  }
  get redBright(): ChalkInstance {
    return this.style(20);
  }
  get greenBright(): ChalkInstance {
    return this.style(21);
  }
  get yellowBright(): ChalkInstance {
    return this.style(22);
  }
  get blueBright(): ChalkInstance {
    return this.style(23);
  }
  get magentaBright(): ChalkInstance {
    return this.style(24);
  }
  get cyanBright(): ChalkInstance {
    return this.style(25);
  }
  get whiteBright(): ChalkInstance {
    return this.style(26);
  }
  get bgBlack(): ChalkInstance {
    return this.style(27);
  }
  get bgRed(): ChalkInstance {
    return this.style(28);
  }
  get bgGreen(): ChalkInstance {
    return this.style(29);
  }
  get bgYellow(): ChalkInstance {
    return this.style(30);
  }
  get bgBlue(): ChalkInstance {
    return this.style(31);
  }
  get bgMagenta(): ChalkInstance {
    return this.style(32);
  }
  get bgCyan(): ChalkInstance {
    return this.style(33);
  }
  get bgWhite(): ChalkInstance {
    return this.style(34);
  }
  get bgBlackBright(): ChalkInstance {
    return this.style(35);
  }
  get bgGray(): ChalkInstance {
    return this.style(36);
  }
  get bgGrey(): ChalkInstance {
    return this.style(37);
  }
  get bgRedBright(): ChalkInstance {
    return this.style(38);
  }
  get bgGreenBright(): ChalkInstance {
    return this.style(39);
  }
  get bgYellowBright(): ChalkInstance {
    return this.style(40);
  }
  get bgBlueBright(): ChalkInstance {
    return this.style(41);
  }
  get bgMagentaBright(): ChalkInstance {
    return this.style(42);
  }
  get bgCyanBright(): ChalkInstance {
    return this.style(43);
  }
  get bgWhiteBright(): ChalkInstance {
    return this.style(44);
  }
}

function optionsLevel(options: Options | undefined): number {
  const level = options === undefined ? undefined : options.level;
  if (
    level !== undefined &&
    level !== 0 &&
    !(Number.isInteger(level) && level >= 0 && level <= 3)
  ) {
    throw new Error("The `level` option should be an integer from 0 to 3");
  }
  if (level === undefined) return stdoutColor === false ? 0 : stdoutColor.level;
  return level;
}

/** `new Chalk(options)`: a fresh chalk instance with its own level. */
export class Chalk extends ChalkInstance {
  constructor(options?: Options) {
    super(new LevelBox(optionsLevel(options)), undefined, false, true);
  }
}

const chalk: ChalkInstance = new Chalk();
export const chalkStderr: ChalkInstance = new Chalk({
  level: stderrColor === false ? 0 : stderrColor.level,
});

export default chalk;
