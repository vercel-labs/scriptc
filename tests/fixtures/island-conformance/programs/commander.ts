import { Command } from "commander";

const program = new Command();

program
  .name("greet")
  .version("1.2.3")
  .argument("<name>", "who to greet")
  .option("-u, --upper", "use uppercase")
  .action((name: string, opts: { upper?: boolean }) => {
    const text = `hello, ${name}`;
    console.log(opts.upper ? text.toUpperCase() : text);
  });

program.parse();
