// Checked conversions of parsed data, and where their failures go. Every
// input below is well-formed JSON that lacks a member the type declares, so
// under Node.js each function returns the parsed value and prints its name
// with "kept". Natively the conversion throws a TypeError. The functions
// SC6009 names take their handler's path and print "dropped"; the others
// report the error. tests/harness/swallowed-conversions.test.ts runs both.
interface Entry {
  id: number;
  name: string;
}
const reported: string[] = [];
function report(e: unknown): void {
  reported.push(e instanceof Error ? e.message : String(e));
}

// The handler has no binding: SC6009.
function bare(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch {
    return null;
  }
}

// The handler reads the error: nothing is lost.
function seen(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch (e) {
    report(e);
    return null;
  }
}

// The handler rethrows what it does not expect: nothing is lost.
function rethrown(text: string): Entry | null {
  try {
    return JSON.parse(text) as Entry;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

// A finally that returns discards the error: SC6009.
function discarded(text: string): Entry | null {
  let entry: Entry | null = null;
  try {
    entry = JSON.parse(text) as Entry;
  } finally {
    return entry;
  }
}

// The conversion is in a function the try calls: SC6009 at the conversion.
function decode(text: string): Entry {
  return JSON.parse(text) as Entry;
}
function called(text: string): Entry | null {
  try {
    return decode(text);
  } catch {
    return null;
  }
}

// A rejection handler that ignores the reason: SC6009 in the callback.
async function chained(text: string): Promise<Entry | null> {
  return Promise.resolve(text)
    .then((t) => JSON.parse(t) as Entry)
    .catch(() => null);
}

// A rejection handler that reads the reason: nothing is lost.
async function chainedSeen(text: string): Promise<Entry | null> {
  return Promise.resolve(text)
    .then((t) => JSON.parse(t) as Entry)
    .catch((e: unknown) => {
      report(e);
      return null;
    });
}

const show = (name: string, entry: Entry | null): void =>
  console.log(name, entry === null ? "dropped" : "kept");

const input = '{"id":1}';
show("bare", bare(input));
show("seen", seen(input));
try {
  show("rethrown", rethrown(input));
} catch (e) {
  report(e);
  console.log("rethrown threw");
}
show("discarded", discarded(input));
show("called", called(input));
show("chained", await chained(input));
show("chainedSeen", await chainedSeen(input));
console.log("reported", reported.length);
