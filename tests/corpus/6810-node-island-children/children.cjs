const { execFile } = require("node:child_process");

exports.run = () =>
  new Promise((resolve, reject) => {
    execFile("/bin/echo", ["island child"], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
