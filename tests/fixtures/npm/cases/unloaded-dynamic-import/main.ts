/// <reference path="./types.d.ts" />
// Packages the project marks never loaded
// (package.json: "scriptc": { "packages": { ...: "unloaded" } }) behind
// import(): a workspace package imported on demand, and a module only
// import() loads whose static import names such a package. Each import()
// rejects with Node's ERR_MODULE_NOT_FOUND, exactly as when the package is
// not installed, and no module of the refused graph evaluates.
// tests/harness/package-shims.test.ts compiles this program with both
// packages installed and checks the output is unchanged.
function report(what: string, err: unknown): void {
  const e = err as { code?: string; message: string };
  const [reason, importer] = e.message.split(" imported from ");
  console.log(what, e.code, reason, importer?.slice(importer.lastIndexOf("/") + 1));
}

async function main(): Promise<void> {
  console.log("start");
  try {
    const { parse } = await import("wsunloadedparser");
    console.log("parsed", parse("a"));
  } catch (err) {
    report("parser:", err);
  }
  try {
    const lazy = await import("./lazy.ts");
    console.log(lazy.run("b"));
  } catch (err) {
    report("lazy:", err);
  }
  console.log("end");
}
main();
