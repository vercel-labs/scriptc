// Own properties written on Error values typed with an intersection.
const coded = new Error("c") as Error & { code?: string };
coded.code = "E1";
console.log(coded.code, "code" in coded);
function has(err: Error): boolean {
  return "code" in err;
}
console.log(has(coded), has(new Error("plain")));
try {
  throw coded;
} catch (e) {
  console.log((e as Error & { code?: string }).code);
}

// System-error members first, then the code: reads stay consistent.
type SysError = Error & { code?: string; errno?: number; syscall?: string; path?: string };
function sysError(message: string, code: string | undefined): SysError {
  const err = new Error(message) as SysError;
  err.errno = -2;
  err.syscall = "open";
  err.path = "/missing";
  err.code = code;
  return err;
}
const enoent = sysError("no such file", "ENOENT");
console.log(enoent.code, enoent.errno, enoent.syscall, enoent.path, "code" in enoent);
console.log(enoent.message, enoent instanceof Error);
const uncoded = sysError("no code", undefined);
console.log(uncoded.code, uncoded.syscall);

// A code that is only known at runtime.
function withCode(err: Error & { code?: string }, code: unknown): void {
  err.code = code as string;
}
const late = new Error("late") as Error & { code?: string };
withCode(late, "ELATE");
console.log(late.code);
late.code = "EAGAIN";
console.log(late.code, late.message);
