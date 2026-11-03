import data from "node:path";

function annotate(data) {
  data.sdkProcessingMetadata = 1;
  return data.sdkProcessingMetadata;
}

console.log(annotate({}));
console.log(data.basename("/tmp/sentry-cli"));
