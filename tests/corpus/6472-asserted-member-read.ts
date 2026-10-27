// `(source as { repoName: string }).repoName` on a union of records: arms
// that declare the member answer it, the others answer undefined, as Node
// reads a missing property.
type GithubSource = { type: string; repoId: number; repoName: string; ref: string };
type GitlabSource = { type: string; projectId: number; ref: string };
type BitbucketSource = { type: string; repoName: string; owner: string; ref: string };
type Source = GithubSource | GitlabSource | BitbucketSource;
function label(source: Source): string {
  return (source as { repoName: string }).repoName || "???";
}
const sources: Source[] = [
  { type: "github", repoId: 1, repoName: "r1", ref: "main" },
  { type: "gitlab", projectId: 2, ref: "dev" },
  { type: "bitbucket", repoName: "", owner: "o", ref: "x" },
];
console.log(sources.map(label));
