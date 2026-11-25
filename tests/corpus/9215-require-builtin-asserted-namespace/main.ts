// A statically known `any`: `require("node:fs")` asserted to the members it
// uses. The compiler knows the value (a builtin module), so the assertion
// converts from that known type at compile time — the destructured bindings
// name the module's own exports, with no dynamic box and no runtime check
// between them and the module. Node runs the same calls against the same
// module object.
const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } =
  require("node:fs") as {
    mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
    writeFileSync(path: string, data: string, options?: string): void;
    readFileSync(path: string, options?: string): string;
    rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
    existsSync(path: string): boolean;
  };

const root = `${process.env["TMPDIR"] ?? "/tmp"}/scriptc-9215-${process.pid}`;
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(`${root}/note.txt`, "checked boundary", "utf-8");
console.log(readFileSync(`${root}/note.txt`, "utf-8"));
console.log(existsSync(`${root}/note.txt`));
rmSync(root, { recursive: true, force: true });
console.log(existsSync(root));
