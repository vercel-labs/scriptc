// @requires-libnode
// A member a package's data interface declares, read on a spread copy the
// program made of an island object's member. The copy's type is the
// program's own and only the member's declaration is the package's: the
// read is a read of data the program holds, so it is not refused as a
// crossing into the package, and it answers what Node answers.
import { makeLambda } from "lambda-kit";
import type { Lambda, NodejsLambda } from "lambda-kit";

function configOf(lambda: Lambda | NodejsLambda) {
  return {
    handler: lambda.handler,
    ...("launcherType" in lambda && lambda.launcherType === "Nodejs"
      ? { launcherType: lambda.launcherType, shouldAddHelpers: lambda.shouldAddHelpers }
      : {}),
    framework: lambda.framework && { ...lambda.framework },
  };
}

const config = configOf(makeLambda("index.handler", "next"));
const input = {
  ...config,
  framework: config.framework && { slug: config.framework.slug },
  size: 3,
};
console.log(JSON.stringify(input));
console.log(config.framework?.slug, config.framework?.version, typeof config.framework?.slug);

// The copy is the program's object: a write to it does not reach the island's.
const lambda = makeLambda("copy.handler", "astro");
const copied = configOf(lambda);
if (copied.framework) {
  copied.framework.slug = "changed";
  console.log(copied.framework.slug, lambda.framework?.slug);
}

// No framework: the member is absent on the copy's holder.
const bare = configOf(makeLambda("other.handler"));
console.log(JSON.stringify({ ...bare, framework: bare.framework && { slug: bare.framework.slug } }));
console.log(bare.framework === undefined, bare.framework?.slug);
