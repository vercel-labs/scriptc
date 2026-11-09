const label = ["command"];
let runs = 0;
console.log("command module evaluates");

export default async (client: { name: string }): Promise<number> => {
  runs += 1;
  console.log(label.join(""), "runs for", client.name, runs);
  return 2;
};
