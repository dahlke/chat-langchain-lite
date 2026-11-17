import { ApiError, type Api } from "./api.ts";
import type { LinearIntegration } from "./engine-integrations.ts";

/** Per-project monthly cap, in LCU. The org has its own cap, shared by every workspace. */
export const ENGINE_SPEND_LIMIT_LCU = "250";

export interface EngineBoard {
  readonly cron_enabled?: boolean;
  readonly auto_open_fix_pr?: boolean;
  readonly preview_verify_enabled?: boolean;
  readonly validation_deployment_id?: string | null;
  readonly session_lcu_spend_limit_monthly?: string | null;
  readonly github_repos?: readonly {
    readonly repo_url: string;
    readonly base_branch: string | null;
  }[];
  readonly linear_integration?: LinearIntegration;
}

export interface EngineTargets {
  /** owner/name of the repo Engine fixes. */
  readonly repo: string;
  readonly production: { readonly name: string; readonly tracer_session_id: string | null };
  readonly development: { readonly id: string };
}

export const boardPath = (sessionId: string) => `/platform/sessions/${sessionId}/issues-agent`;

function productionSession(targets: EngineTargets): string {
  const sessionId = targets.production.tracer_session_id;
  if (!sessionId) throw new Error(`${targets.production.name} has no tracing project yet.`);
  return sessionId;
}

export const repoSlug = (url: string) =>
  url
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();

/** Creating a board starts its first scan. */
export function createBoardBody(targets: EngineTargets) {
  return {
    // Engine verifies only fixes in the board's first repo.
    github_repos: [{ repo_url: targets.repo, subdir: "agent", base_branch: "development" }],
    // GitHub builds sync Context Hub into a repo named after the deployment.
    context_hub_repo_handle: targets.production.name,
    auto_open_fix_pr: true,
    analysis_level: "reduced",
    // Experiments run on production too; Engine filters allow only name, tag and metadata conditions.
    run_filter: 'neq(metadata_key, "ls_experiment_id")',
  };
}

export function boardSettings(targets: EngineTargets) {
  return {
    cron_enabled: true,
    validation_deployment_id: targets.development.id,
    preview_verify_enabled: true,
    // Verification starts only once the fix has a PR; merge-guard holds it open.
    auto_open_fix_pr: true,
    context_hub_repo_handle: targets.production.name,
    session_lcu_spend_limit_monthly: ENGINE_SPEND_LIMIT_LCU,
  };
}

/** What keeps the board from scanning production and verifying fixes on development's previews. */
export function boardProblems(board: EngineBoard, targets: EngineTargets): string[] {
  const [first] = board.github_repos ?? [];
  return [
    ...(board.cron_enabled ? [] : ["scanning is paused"]),
    ...(board.preview_verify_enabled ? [] : ["fix verification is off"]),
    ...(board.auto_open_fix_pr ? [] : ["fix PRs don't open on their own"]),
    ...(board.validation_deployment_id === targets.development.id
      ? []
      : ["fixes aren't verified against development"]),
    ...(first &&
    repoSlug(first.repo_url) === targets.repo.toLowerCase() &&
    first.base_branch === "development"
      ? []
      : [`its first repo isn't ${targets.repo} on development`]),
  ];
}

export async function findBoard(api: Api, sessionId: string): Promise<EngineBoard | null> {
  try {
    return await api.get<EngineBoard>(boardPath(sessionId));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Creates the production board if it's missing, then makes it scan and verify fixes. */
export async function ensureBoard(
  api: Api,
  targets: EngineTargets,
  log: (line: string) => void,
): Promise<void> {
  const path = boardPath(productionSession(targets));
  if (!(await findBoard(api, productionSession(targets)))) {
    await api.post(path, createBoardBody(targets));
    log("created the Engine board on production; its first scan has started");
  }
  await api.patch(path, boardSettings(targets));
  log(
    `Engine scans production daily (up to ${ENGINE_SPEND_LIMIT_LCU} LCU a month) and verifies its fixes on previews of development`,
  );
}

/** Removes the board with its issues. Returns false when there was none. */
export async function deleteBoard(api: Api, targets: EngineTargets): Promise<boolean> {
  try {
    await api.delete(boardPath(productionSession(targets)));
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

export interface PullRequest {
  readonly number: number;
  readonly headRefName: string;
  readonly author: { readonly login: string };
  readonly labels: readonly { readonly name: string }[];
}

/** Same rule as .github/workflows/merge-guard.yml. */
export function isEngineFix(pr: PullRequest): boolean {
  return (
    pr.labels.some((label) => label.name === "Engine") ||
    /^(langsmith-engine|issues-agent)\//.test(pr.headRefName) ||
    pr.author.login === "langsmith-engine[bot]" ||
    pr.author.login === "app/langsmith-engine"
  );
}
