import { exec } from "node:child_process";

exec("exit 3", (error) => {
  if (error === null) return;
  console.log(error.code);
  console.log("code" in error);
  console.log(typeof error.code === "number");
});
