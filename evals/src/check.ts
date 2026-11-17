import { parseArgs } from "node:util";

import { agentApi, ask, findDeployment, type Environment } from "./agent.ts";
import { createApi, type Api } from "./api.ts";
import { readConfig } from "./config.ts";
import { findAgentDeployment, PREVIEW_CONFIG, revisionState } from "./deployments.ts";
import { boardProblems, findBoard } from "./engine.ts";
import {
  integrationProblems,
  readIntegrations,
  type EngineIntegrations,
} from "./engine-integrations.ts";
import { TONE_RULE_NAME } from "./evaluators.ts";
import { originRepo, run } from "./github.ts";
import {
  check,
  describeSpend,
  HEALTH_LABEL,
  issueAction,
  judgeProblem,
  renderReport,
  SCHEDULED_WORKFLOWS,
  spendProblems,
  type CheckResult,
} from "./health.ts";

const log = (line: string) => console.log(`[check] ${line}`);
const ENVIRONMENTS: readonly Environment[] = ["production", "development"];

const gh = (args: readonly string[], input?: string) => run("gh", args, input);
const ghJson = <T>(args: readonly string[]) => JSON.parse(gh(args)) as T;

async function deploymentCheck(hostApi: Api, environment: Environment): Promise<string> {
  const record = await findAgentDeployment(hostApi, environment);
  if (!record) throw new Error("not deployed");
  const revisionId = record.latest_revision_id;
  if (!revisionId) throw new Error(`${record.name} has no revision`);
  const { status } = await hostApi.get<{ status: string }>(
    `/v2/deployments/${record.id}/revisions/${revisionId}`,
  );
  if (revisionState(status) === "failed") throw new Error(`${record.name}: latest build ${status}`);
  if (!record.active_revision_id)
    throw new Error(`${record.name}: nothing serving yet (${status})`);
  return `${record.name}: ${status}`;
}

/** Answers with the workspace's key, and refuses a request without credentials. */
async function agentCheck(
  config: ReturnType<typeof readConfig>,
  hostApi: Api,
  environment: Environment,
) {
  const deployment = await findDeployment(hostApi, environment);
  const result = await ask(agentApi(config, deployment), "Hi! What can you help with?", {
    metadata: { source: "demo-check" },
  });
  if (!result.answer.text.trim()) throw new Error("answered with an empty message");
  const anonymous = await fetch(`${deployment.url}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (anonymous.status !== 401 && anonymous.status !== 403)
    throw new Error(`accepted a request without credentials (${anonymous.status})`);
  return "answers, and refuses requests without credentials";
}

async function engineCheck(api: Api, hostApi: Api, repo: string): Promise<string> {
  const production = await findAgentDeployment(hostApi, "production");
  const development = await findAgentDeployment(hostApi, "development");
  if (!production?.tracer_session_id || !development) throw new Error("deployments missing");
  const board = await findBoard(api, production.tracer_session_id);
  if (!board) throw new Error("no board on production. Run mise run demo:install");
  const problems = boardProblems(board, { repo, production, development });
  const [project, org] = await Promise.all([
    api.get<{ total_lcu: string }>("/platform/orgs/current/issues-agent/lcu-spend", {
      session_id: production.tracer_session_id,
    }),
    api.get<{ total_lcu: string; resolved_monthly_spend_limit_lcu: string | null }>(
      "/platform/orgs/current/issues-agent/lcu-spend",
    ),
  ]);
  const limit = board.session_lcu_spend_limit_monthly;
  const spend = {
    projectLcu: Number(project.total_lcu),
    projectLimitLcu: limit ? Number(limit) : null,
    orgLcu: Number(org.total_lcu),
    orgLimitLcu: org.resolved_monthly_spend_limit_lcu
      ? Number(org.resolved_monthly_spend_limit_lcu)
      : null,
  };
  problems.push(...spendProblems(spend));
  if (problems.length > 0) throw new Error(`${problems.join("; ")}. ${describeSpend(spend)}`);
  return `scanning and verifying fixes; ${describeSpend(spend)}`;
}

async function integrationsCheck(
  api: Api,
  hostApi: Api,
  integrations: EngineIntegrations,
): Promise<string> {
  const wanted = [
    ...(integrations.slackChannel ? [`#${integrations.slackChannel}`] : []),
    ...(integrations.linear ? [`Linear ${integrations.linear.team}`] : []),
  ];
  if (wanted.length === 0) return "none configured";
  const production = await findAgentDeployment(hostApi, "production");
  if (!production?.tracer_session_id) throw new Error("production isn't deployed");
  const board = await findBoard(api, production.tracer_session_id);
  if (!board) throw new Error("no board on production. Run mise run demo:install");
  const problems = await integrationProblems(
    api,
    production.tracer_session_id,
    board.linear_integration,
    integrations,
  );
  if (problems.length > 0) throw new Error(problems.join("; "));
  return `reports to ${wanted.join(" and ")}`;
}

async function judgeCheck(api: Api, hostApi: Api): Promise<string> {
  const production = await findAgentDeployment(hostApi, "production");
  if (!production?.tracer_session_id) throw new Error("production isn't deployed");
  const [latest] = await api.get<{ created_at: string }[]>("/feedback", {
    session: production.tracer_session_id,
    key: TONE_RULE_NAME,
    limit: 1,
  });
  const problem = judgeProblem(latest?.created_at ?? null, new Date());
  if (problem) throw new Error(`${TONE_RULE_NAME} ${problem}; check the LC_GATEWAY_KEY secret`);
  return `${TONE_RULE_NAME} scored a production trace at ${latest?.created_at}`;
}

async function previewCheck(hostApi: Api): Promise<string> {
  const development = await findAgentDeployment(hostApi, "development");
  if (!development) throw new Error("development isn't deployed");
  const settings = await hostApi.get<{ enabled: boolean; ttl_seconds: number | null }>(
    `/v2/deployments/${development.id}/preview-builds/config`,
  );
  if (!settings.enabled) throw new Error("previews are off");
  if (settings.ttl_seconds !== PREVIEW_CONFIG.ttl_seconds)
    throw new Error(`previews expire after ${settings.ttl_seconds}s idle`);
  return "on, and they don't expire";
}

async function pagesCheck(repo: string): Promise<string> {
  const { html_url: site } = ghJson<{ html_url: string }>(["api", `repos/${repo}/pages`]);
  const response = await fetch(site);
  if (!response.ok) throw new Error(`${site} returned ${response.status}`);
  return site;
}

async function workflowsCheck(repo: string): Promise<string> {
  const { workflows } = ghJson<{ workflows: { path: string; state: string }[] }>([
    "api",
    `repos/${repo}/actions/workflows`,
  ]);
  const off = SCHEDULED_WORKFLOWS.filter(
    (file) => workflows.find((workflow) => workflow.path.endsWith(`/${file}`))?.state !== "active",
  );
  if (off.length > 0) throw new Error(`not running on schedule: ${off.join(", ")}`);
  const [last] = ghJson<{ conclusion: string; createdAt: string }[]>([
    "run",
    "list",
    "-R",
    repo,
    "--workflow",
    "trickle.yml",
    "--status",
    "completed",
    "--limit",
    "1",
    "--json",
    "conclusion,createdAt",
  ]);
  if (last && last.conclusion !== "success")
    throw new Error(`the last trickle run (${last.createdAt}) ended ${last.conclusion}`);
  return last ? `scheduled; last trickle ${last.createdAt}` : "scheduled; no trickle run yet";
}

function reportToIssue(repo: string, results: readonly CheckResult[]) {
  const [open] = ghJson<{ number: number }[]>([
    "issue",
    "list",
    "-R",
    repo,
    "--label",
    HEALTH_LABEL,
    "--state",
    "open",
    "--json",
    "number",
  ]);
  const action = issueAction(open?.number ?? null, results);
  const runUrl = process.env.GITHUB_RUN_ID
    ? `\n\n[Health check run](${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID})`
    : "";
  const body = `${renderReport(results)}${runUrl}`;
  if (action.kind === "open") {
    gh(["label", "create", HEALTH_LABEL, "-R", repo, "--color", "B60205", "--force"]);
    gh(
      [
        "issue",
        "create",
        "-R",
        repo,
        "--title",
        "The demo needs attention",
        "--label",
        HEALTH_LABEL,
        "--body-file",
        "-",
      ],
      body,
    );
    log("opened an issue");
  } else if (action.kind === "comment") {
    gh(["issue", "comment", String(action.issue), "-R", repo, "--body-file", "-"], body);
    log(`commented on issue #${action.issue}`);
  } else if (action.kind === "close") {
    gh([
      "issue",
      "close",
      String(action.issue),
      "-R",
      repo,
      "--comment",
      `Healthy again.\n\n${body}`,
    ]);
    log(`closed issue #${action.issue}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: { "github-issue": { type: "boolean", default: false } },
  });
  const config = readConfig(process.env);
  const client = (baseUrl: string) =>
    createApi({ baseUrl, apiKey: config.apiKey, workspaceId: config.workspaceId });
  const api = client(config.apiUrl);
  const hostApi = client(config.hostUrl);
  const repo = process.env.GITHUB_REPOSITORY ?? originRepo();
  const integrations = readIntegrations(process.env);

  const results: CheckResult[] = [];
  for (const environment of ENVIRONMENTS) {
    results.push(
      await check(`${environment} deployment`, () => deploymentCheck(hostApi, environment)),
    );
    results.push(
      await check(`${environment} agent`, () => agentCheck(config, hostApi, environment)),
    );
  }
  results.push(
    await check("Tone judge", () => judgeCheck(api, hostApi)),
    await check("Engine", () => engineCheck(api, hostApi, repo)),
    await check("Engine integrations", () => integrationsCheck(api, hostApi, integrations)),
    await check("Previews", () => previewCheck(hostApi)),
    await check("Pages", () => pagesCheck(repo)),
    await check("Scheduled workflows", () => workflowsCheck(repo)),
  );

  for (const result of results)
    log(`${result.ok ? "ok  " : "FAIL"} ${result.name}: ${result.detail}`);
  if (values["github-issue"]) reportToIssue(repo, results);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`[check] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
