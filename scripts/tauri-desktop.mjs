// The Cargo default feature is `server`; the frozen desktop app needs `desktop` alone.
// tauri-cli has no --no-default-features option, so `dev` and `build` pass it to cargo
// as a runner argument after `--`; other subcommands go to the CLI unchanged.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const args = process.argv.slice(2);

if (["dev", "build"].includes(args[0]) && !args.includes("--no-default-features")) {
  const [command, ...rest] = args;
  const separator = rest.indexOf("--");
  const options = separator === -1 ? rest : rest.slice(0, separator);
  const runnerArgs = separator === -1 ? [] : rest.slice(separator + 1);
  args.splice(0, args.length, command, "--features", "desktop", ...options, "--", "--no-default-features", ...runnerArgs);
}

const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
