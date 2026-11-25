// Static import() embeds a fixed graph, so a runtime-computed specifier
// remains an explicit refusal even though literal program/builtin modules
// now compile without the dynamic engine, and specifiers the build can bound
// (a const, a module-local function's parameter) compile as literal edges.
// An EXPORTED function has callers outside the file, so its parameter cannot
// be bounded.
export async function run(specifier: string): Promise<void> {
  const module = await import(specifier);
  console.log(module);
}
void run("node:path");
