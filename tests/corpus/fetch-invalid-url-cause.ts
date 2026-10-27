// An unparsable fetch() or Request URL is undici's TypeError
// "Failed to parse URL from <input>", whose non-enumerable cause is the
// URL parser's TypeError.
function report(label: string, e: unknown): void {
  const serialized = JSON.stringify(e);
  if (!(e instanceof Error)) {
    console.log(label, "not an Error");
    return;
  }
  console.log(label, e.name, e.message, e instanceof TypeError);
  console.log("  has cause:", "cause" in e, "own enumerable:", serialized);
  console.log(
    "  cause:",
    e.cause instanceof Error ? `${e.cause.name} ${e.cause.message} ${e.cause instanceof TypeError}` : String(e.cause),
  );
}

async function main(): Promise<void> {
  for (const input of ["http://127.0.0.1:1http://x/", "/relative/path", "", "http://[::1"]) {
    try {
      await fetch(input);
      console.log("resolved?");
    } catch (e) {
      report(`fetch(${JSON.stringify(input)})`, e);
    }
  }
  try {
    new Request("not a url");
    console.log("constructed?");
  } catch (e) {
    report("new Request", e);
  }
  // A valid URL with credentials keeps its own message.
  try {
    await fetch("http://user:pass@127.0.0.1:1/");
  } catch (e) {
    report("credentials", e);
  }
}

void main();
