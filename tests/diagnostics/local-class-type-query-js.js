// A whole-program analysis that queries types before reachability is known
// (the computed-key write census here, through `holder.p`) names a
// function-local class whose collection is refused. The refusal is reported,
// once, at the class; it used to crash the compiler with an uncaught
// PoisonError.
function main() {
  const Project = class _Project {
    constructor() {
      this.name = "p";
    }
    close() {
      if (this.missingFilesMap) {
        this.missingFilesMap.clear();
        this.missingFilesMap = void 0;
      }
    }
    add(k) {
      (this.missingFilesMap || (this.missingFilesMap = new Map())).set(k, 1);
    }
  };
  const holder = { p: new Project() };
  const key = process.argv.length > 5 ? String(process.argv.length) : "name";
  holder.p[key] = "q";
  console.log(holder.p.name);
}
main();
