import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const targetScript = process.argv[2];
const supportedMajor = 22;
const fallbackNodeVersion = "22.20.0";
const fallbackNodePaths = [
  join(process.env.HOME || "", ".nvm", "versions", "node", `v${fallbackNodeVersion}`, "bin"),
  "/opt/homebrew/opt/node@22/bin",
  "/usr/local/opt/node@22/bin",
];

function findHomebrewNode22Path() {
  const roots = ["/opt/homebrew/Cellar/node@22", "/usr/local/Cellar/node@22"];
  for (const root of roots) {
    try {
      const versions = readdirSync(root)
        .filter((name) => existsSync(join(root, name, "bin", "node")) && existsSync(join(root, name, "bin", "npm")))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (versions[0]) return join(root, versions[0], "bin");
    } catch {
      // 尝试下一个 Homebrew 路径。
    }
  }
  return "";
}

if (!targetScript) {
  console.error("[node-runtime] missing target npm script");
  process.exit(1);
}

const currentMajor = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);

function run(scriptName, env = process.env) {
  const result = spawnSync("npm", ["run", scriptName], {
    stdio: "inherit",
    env
  });
  process.exit(result.status || 0);
}

if (currentMajor <= supportedMajor) {
  run(targetScript);
}

if (process.env.NN_PLATFORM_NODE_REEXEC === "1") {
  console.error(
    `[node-runtime] Node ${process.version} is not supported by better-sqlite3@9.x. ` +
      `Please use Node ${fallbackNodeVersion}.`
  );
  process.exit(1);
}

const fallbackNodePath = [...fallbackNodePaths, findHomebrewNode22Path()]
  .filter(Boolean)
  .find((nodePath) => existsSync(join(nodePath, "node")) && existsSync(join(nodePath, "npm")));

if (!fallbackNodePath) {
  console.error(
    `[node-runtime] Node ${process.version} is not supported by better-sqlite3@9.x, ` +
      `and no fallback Node 22 runtime was found.`
  );
  console.error(`[node-runtime] Install Node 22 with: brew install node@22`);
  console.error(`[node-runtime] Or with nvm: source ~/.nvm/nvm.sh && nvm install ${fallbackNodeVersion}`);
  process.exit(1);
}

console.log(`[node-runtime] switch Node ${process.version} -> ${fallbackNodePath}/node for npm run ${targetScript}`);
run(targetScript, {
  ...process.env,
  NN_PLATFORM_NODE_REEXEC: "1",
  PATH: `${fallbackNodePath}:${process.env.PATH || ""}`,
  npm_config_prefix: dirname(fallbackNodePath)
});
