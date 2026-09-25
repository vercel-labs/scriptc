// The island loads the DNS promises module, but queries reject because it has no DNS client.
import { probeDnsRefusal } from "plumbing";

async function run(): Promise<void> {
  const report: string = await probeDnsRefusal();
  console.log(report);
}

void run();
