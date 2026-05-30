import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const targetScript = process.argv[2];
const supportedMajor = 22;
const fallbackNodeVersion = "22.20.0";
const fallbackNodePath = join(
  process.env.HOME || "",
  ".nvm",
  "versions",
  "node",
  `v${fallbackNodeVersion}`,
  "bin"
);

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

if (!existsSync(join(fallbackNodePath, "node")) || !existsSync(join(fallbackNodePath, "npm"))) {
  console.error(
    `[node-runtime] Node ${process.version} is not supported by better-sqlite3@9.x, ` +
      `and fallback Node ${fallbackNodeVersion} was not found at ${fallbackNodePath}.`
  );
  console.error(`[node-runtime] Run: source ~/.nvm/nvm.sh && nvm install ${fallbackNodeVersion}`);
  process.exit(1);
}

console.log(`[node-runtime] switch Node ${process.version} -> v${fallbackNodeVersion} for npm run ${targetScript}`);
run(targetScript, {
  ...process.env,
  NN_PLATFORM_NODE_REEXEC: "1",
  PATH: `${fallbackNodePath}:${process.env.PATH || ""}`,
  npm_config_prefix: dirname(fallbackNodePath)
});
