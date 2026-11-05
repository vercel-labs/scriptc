// A record with a string index signature satisfies a record whose members are
// all optional: TypeScript accepts it because any key may answer, and the
// conversion reads a member the source declares only through its signature
// from the source's own storage instead of completing it absent.

type Args = Record<string, unknown> & {
  command: string;
  json: boolean;
  name: string;
};

interface OutputOptions {
  json?: boolean;
  color?: boolean;
  "no-color"?: boolean;
}

function describe(options: OutputOptions): string {
  return JSON.stringify({
    json: options.json,
    color: options.color,
    noColor: options["no-color"],
  });
}

const parsed: Args = { command: "list", json: true, name: "relay", color: false };
console.log(describe(parsed));

const plain: Args = { command: "list", json: false, name: "relay", "no-color": true };
console.log(describe(plain));

function printFailure(failure: string, jsonMode: boolean, args: OutputOptions = {}): void {
  console.log(failure, jsonMode, args.json, args.color);
}
printFailure("missing", true, parsed);
printFailure("quiet", false);

const maybe: Args | undefined = parsed;
console.log(describe(maybe));
console.log(maybe?.["no-color"], parsed.command);
