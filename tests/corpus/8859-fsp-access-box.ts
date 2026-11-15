// A bounded import() of node:fs/promises serves its fixed-signature members
// as function values, so `fs.access` read through the checked-dynamic
// namespace box is a real function: it resolves for an existing path and
// rejects for a missing one. Before the value form existed the read itself
// failed its checked conversion, and a `try`/`catch` around it (the shape
// fileExists below has) answered `false` where Node answers `true`.
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

interface NodeFsModule {
  access(path: string): Promise<void>;
  truncate(path: string, len?: number): Promise<void>;
}
interface NodeOsModule {
  homedir(): string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
    let resolved = path;
    if (resolved.startsWith("~")) {
      const os = (await importNodeModule("node:os")) as NodeOsModule;
      resolved = os.homedir() + resolved.slice(1);
    }
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
  console.log("typeof access:", typeof fs.access);
  console.log("typeof truncate:", typeof fs.truncate);
  console.log("exists root:", await fileExists("/"));
  console.log("exists missing:", await fileExists("/scriptc-no-such-path-8859"));
  console.log("exists home:", await fileExists("~"));
  console.log("exists missing under home:", await fileExists("~/scriptc-no-such-path-8859"));

  const access: (path: string) => Promise<void> = fs.access;
  try {
    await access("/scriptc-no-such-path-8859");
    console.log("unexpected access success");
  } catch (error) {
    console.log("access rejects:", (error as Error).name, (error as NodeJS.ErrnoException).code);
  }

  const truncate: (path: string, len?: number) => Promise<void> = fs.truncate;
  try {
    await truncate("/scriptc-no-such-path-8859", 0);
  } catch (error) {
    console.log("truncate rejects:", (error as NodeJS.ErrnoException).code);
  }
}

void main();
