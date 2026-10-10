// A scanner stores its error callback in a field named like the method of
// the reporter classes that receive the errors, as a compiler's scanner and
// diagnostic reporters do. Writes that can reach a class method still
// replace it: through `this` in a subclass and an interface-typed parameter.
type ErrorCallback = (message: string, start: number) => void;

class Scanner {
  private onError: ErrorCallback | undefined = undefined;
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  setOnError(onError: ErrorCallback | undefined): void {
    this.onError = onError;
  }
  scan(): number {
    let count = 0;
    for (let i = 0; i < this.text.length; i++) {
      if (this.text[i] === "!") {
        count++;
        if (this.onError !== undefined) this.onError("unexpected '!'", i);
      }
    }
    return count;
  }
}

class Reporter {
  readonly lines: string[] = [];
  errors = 0;
  onError(message: string, start: number): void {
    this.errors = this.errors + 1;
    this.lines.push(`${start}: ${message}`);
  }
}

const reporter = new Reporter();
const scanner = new Scanner("a!b!!c");
scanner.setOnError((message, start) => reporter.onError(message, start));
console.log(scanner.scan(), reporter.errors, reporter.lines.join("; "));
scanner.setOnError(undefined);
console.log(scanner.scan(), reporter.errors);

// `this` in a subclass replaces an inherited method on that instance.
class Base {
  describe(): string {
    return "base";
  }
}
class Patched extends Base {
  patch(): void {
    this.describe = () => "patched";
  }
}
const patched = new Patched();
console.log(patched.describe());
patched.patch();
console.log(patched.describe(), new Patched().describe(), new Base().describe());

// An interface-typed parameter can hold a class instance.
interface Labeled {
  label: () => string;
}
class Tag {
  label(): string {
    return "tag";
  }
}
function relabel(target: Labeled, text: string): void {
  target.label = () => text;
}
const tag = new Tag();
relabel(tag, "renamed");
console.log(tag.label(), new Tag().label());
