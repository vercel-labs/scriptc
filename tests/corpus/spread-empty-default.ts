// `...(options ?? {})` and `...(options || {})` spread exactly what
// `...options` spreads: nullish and other falsy values contribute no keys.
// The optional source is an Omit<> view of an options interface whose
// fields include a function, so a checked-dynamic copy cannot hold it.
interface LoaderOptions {
  cwd: string;
  agentDir: string;
  extraPaths?: string[];
  onLoad?: (paths: string[]) => string[];
}
interface ServiceOptions {
  cwd: string;
  loaderOptions?: Omit<LoaderOptions, "cwd" | "agentDir">;
}
class Loader {
  readonly options: LoaderOptions;
  constructor(options: LoaderOptions) {
    this.options = options;
  }
  describe(): string {
    const paths = this.options.onLoad?.(this.options.extraPaths ?? []) ?? [];
    return `${this.options.cwd} ${this.options.agentDir} [${paths.join(",")}]`;
  }
}
function viaNullish(options: ServiceOptions): Loader {
  return new Loader({ ...(options.loaderOptions ?? {}), cwd: options.cwd, agentDir: "/agent" });
}
function viaOr(options: ServiceOptions): Loader {
  return new Loader({ cwd: options.cwd, agentDir: "/or", ...(options.loaderOptions || {}) });
}
let evaluated = 0;
function counted(options: ServiceOptions): ServiceOptions["loaderOptions"] {
  evaluated++;
  return options.loaderOptions;
}
function viaCall(options: ServiceOptions): Loader {
  return new Loader({ ...(counted(options) ?? {}), cwd: options.cwd, agentDir: "/call" });
}
const bare: ServiceOptions = { cwd: "/w" };
const full: ServiceOptions = { cwd: "/w", loaderOptions: { extraPaths: ["x"], onLoad: (p) => [...p, "y"] } };
console.log(viaNullish(bare).describe());
console.log(viaNullish(full).describe());
console.log(viaOr(bare).describe());
console.log(viaOr(full).describe());
console.log(viaCall(bare).describe(), viaCall(full).describe(), evaluated);
