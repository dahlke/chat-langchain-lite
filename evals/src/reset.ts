import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createApi } from "./api.ts";
import { readConfig } from "./config.ts";
import { findAgentDeployment } from "./deployments.ts";
import {
  deleteBoard,
  ensureBoard,
  findBoard,
  isEngineFix,
  type EngineTargets,
  type PullRequest,
} from "./engine.ts";
import { ensureIntegrations, readIntegrations } from "./engine-integrations.ts";
import { originRepo, run } from "./github.ts";

const log = (line: string) => console.log(`[reset] ${line}`);
const gh = (args: readonly string[]) => run("gh", args);

function prepare(args: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("prepare.ts", import.meta.url)), ...args],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`prepare ${args.join(" ")} failed`);
}

/** Starts Engine's part of the demo over: no fix PRs, an empty board, and a fresh scan. Never touches branches. */
async function main() {
  const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } } });
  const config = readConfig(process.env);
  const client = (baseUrl: string) =>
    createApi({ baseUrl, apiKey: config.apiKey, workspaceId: config.workspaceId });
  const api = client(config.apiUrl);
  const hostApi = client(config.hostUrl);
  const repo = process.env.GITHUB_REPOSITORY ?? originRepo();

  const production = await findAgentDeployment(hostApi, "production");
  const development = await findAgentDeployment(hostApi, "development");
  if (!production?.tracer_session_id || !development)
    throw new Error("Both environments must be deployed. Run mise run demo:install first.");
  const targets: EngineTargets = { repo, production, development };

  const fixes = (
    JSON.parse(
      gh([
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,headRefName,author,labels",
      ]),
    ) as PullRequest[]
  ).filter(isEngineFix);
  const board = await findBoard(api, production.tracer_session_id);
  log(
    `${repo}: ${board ? "delete the Engine board and its issues" : "no Engine board yet"}; close ${fixes.length} Engine fix PR(s)${fixes.length ? ` (${fixes.map((pr) => `#${pr.number}`).join(", ")})` : ""}; send traffic; create a board, which scans; refresh the experiments`,
  );
  if (!values.yes) return log("dry run: nothing changed. Re-run with --yes to reset.");

  if (await deleteBoard(api, targets)) log("deleted the Engine board");
  for (const pr of fixes) {
    gh([
      "pr",
      "close",
      String(pr.number),
      "-R",
      repo,
      "--delete-branch",
      "--comment",
      "Closed by the demo reset. Engine opens a new fix after its next scan.",
    ]);
    log(`closed #${pr.number}`);
  }
  // Fresh evidence first: the new board's first scan reads recent production traces.
  prepare(["--only", "traffic"]);
  await ensureBoard(api, targets, log);
  // Deleting the board deleted its Slack destination and Linear connection.
  await ensureIntegrations(api, production.tracer_session_id, readIntegrations(process.env), log);
  prepare(["--only", "experiments", "--refresh"]);
  log("done. Engine's issues reappear on the board after its scan, then its fix PRs and verdicts.");
}

main().catch((error: unknown) => {
  console.error(`[reset] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
