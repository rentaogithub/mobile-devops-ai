import { spawnSync } from "node:child_process";

const nativeModules = ["better-sqlite3"];

function canLoad(moduleName) {
  const checkScript =
    moduleName === "better-sqlite3"
      ? `
          const Database = require("better-sqlite3");
          const db = new Database(":memory:");
          db.close();
        `
      : `require(${JSON.stringify(moduleName)})`;
  const result = spawnSync(
    process.execPath,
    ["-e", checkScript],
    { stdio: "pipe" }
  );
  return result.status === 0;
}

function rebuild(moduleName) {
  console.log(`[native-deps] rebuild ${moduleName} for Node ${process.version}`);
  const env = {
    ...process.env,
    CXXFLAGS: `${process.env.CXXFLAGS || ""} -std=c++20`.trim()
  };
  const result = spawnSync("npm", ["rebuild", moduleName], {
    stdio: "inherit",
    env
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

for (const moduleName of nativeModules) {
  if (!canLoad(moduleName)) {
    rebuild(moduleName);
  }
}
