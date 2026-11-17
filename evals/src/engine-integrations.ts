import { ApiError, type Api } from "./api.ts";
import { boardPath } from "./engine.ts";

/** Where Engine reports its issues besides its board. A blank part is skipped. */
export interface EngineIntegrations {
  /** A public Slack channel's name, without the #. */
  readonly slackChannel?: string;
  readonly linear?: LinearTarget;
}

export interface LinearTarget {
  /** The Linear team's key, such as DEP. */
  readonly team: string;
  readonly project?: string;
}

/** Repo variables install copies from agent/.env, for the workflows that replace the board. */
export const INTEGRATION_VARIABLES = [
  "ENGINE_SLACK_CHANNEL",
  "ENGINE_LINEAR_TEAM",
  "ENGINE_LINEAR_PROJECT",
] as const;

export function readIntegrations(env: Record<string, string | undefined>): EngineIntegrations {
  const value = (name: (typeof INTEGRATION_VARIABLES)[number]) => env[name]?.trim() || undefined;
  const slackChannel = value("ENGINE_SLACK_CHANNEL")?.replace(/^#/, "");
  const team = value("ENGINE_LINEAR_TEAM")?.toUpperCase();
  const project = value("ENGINE_LINEAR_PROJECT");
  if (project && !team)
    throw new Error("ENGINE_LINEAR_PROJECT needs ENGINE_LINEAR_TEAM, the Linear team's key.");
  return {
    ...(slackChannel ? { slackChannel } : {}),
    ...(team ? { linear: { team, ...(project ? { project } : {}) } } : {}),
  };
}

// Slack

export interface SlackChannel {
  readonly teamId: string;
  readonly channelId: string;
}

export interface SlackDestination {
  readonly destination_type: string;
  readonly slack_channel_id?: string | null;
}

export const SLACK_EVENTS = ["issue.created", "issue.fix_pr.opened"] as const;

export function slackDestinationBody(channel: SlackChannel) {
  return {
    slack_team_id: channel.teamId,
    slack_channel_id: channel.channelId,
    // 3 is the lowest severity, so every issue posts.
    severity_threshold: 3,
    event_types: SLACK_EVENTS,
  };
}

export const postsTo = (destinations: readonly SlackDestination[], channel: SlackChannel) =>
  destinations.some(
    (destination) =>
      destination.destination_type === "slack" &&
      destination.slack_channel_id === channel.channelId,
  );

const webhooksPath = (sessionId: string) => `${boardPath(sessionId)}/webhooks`;

/** Looks the channel up in each Slack workspace connected to LangSmith's org. */
export async function findSlackChannel(api: Api, name: string): Promise<SlackChannel | null> {
  const installations = await api.get<readonly { team_id: string }[]>(
    "/platform/slack/installations",
  );
  if (installations.length === 0)
    throw new Error("no Slack workspace is connected to the LangSmith org");
  // LangSmith caches each workspace's channel list; refresh only when the channel isn't in it.
  for (const refresh of [false, true]) {
    for (const { team_id: teamId } of installations) {
      const channels = await api.get<readonly { id: string; name: string }[]>(
        `/platform/slack/installations/${teamId}/channels`,
        refresh ? { refresh: true } : undefined,
      );
      const match = channels.find((channel) => channel.name === name);
      if (match) return { teamId, channelId: match.id };
    }
  }
  return null;
}

async function ensureSlack(api: Api, sessionId: string, name: string): Promise<string> {
  const channel = await findSlackChannel(api, name);
  if (!channel) throw new Error(`#${name} isn't a public channel LangSmith's Slack app can see`);
  const destinations = await api.get<readonly SlackDestination[]>(webhooksPath(sessionId));
  if (!postsTo(destinations, channel)) {
    await api.post(webhooksPath(sessionId), slackDestinationBody(channel));
  }
  return `Engine posts new issues and fix PRs to #${name}`;
}

// Linear

export interface LinearIntegration {
  readonly enabled?: boolean;
  readonly team_key?: string | null;
  readonly project_name?: string | null;
}

interface LinearTeam {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly workspace_id: string;
  readonly workspace_name: string;
}

interface LinearProject {
  readonly id: string;
  readonly name: string;
}

const LINEAR_NOT_CONNECTED =
  "Linear isn't connected to the Engine board. Connect it in the board's settings in LangSmith, then re-run mise run demo:install";

const describeLinear = (team: string, project: string | undefined) =>
  project ? `${team} / ${project}` : team;

export function linearMatches(current: LinearIntegration | undefined, target: LinearTarget) {
  return (
    current?.enabled === true &&
    current.team_key === target.team &&
    (current.project_name ?? undefined) === target.project
  );
}

export function linearIntegrationBody(team: LinearTeam, project: LinearProject | undefined) {
  return {
    linear_integration: {
      enabled: true,
      workspace_id: team.workspace_id,
      workspace_name: team.workspace_name,
      team_id: team.id,
      team_name: team.name,
      team_key: team.key,
      ...(project ? { project_id: project.id, project_name: project.name } : {}),
    },
  };
}

/** Engine statuses whose issues still belong in Linear. */
const ACTIVE_STATUSES = new Set(["open", "fixing", "watching"]);

async function ensureLinear(api: Api, sessionId: string, target: LinearTarget): Promise<string> {
  const path = boardPath(sessionId);
  const where = describeLinear(target.team, target.project);
  const board = await api.get<{ linear_integration?: LinearIntegration }>(path);
  if (linearMatches(board.linear_integration, target))
    return `Engine files its issues in Linear (${where})`;

  let teams: readonly LinearTeam[];
  try {
    ({ teams } = await api.get<{ teams: readonly LinearTeam[] }>(`${path}/linear/teams`));
  } catch (error) {
    // Deleting the board deletes its Linear connection, and only the UI can make a new one.
    if (error instanceof ApiError && error.status === 409) throw new Error(LINEAR_NOT_CONNECTED);
    throw error;
  }
  const team = teams.find((candidate) => candidate.key === target.team);
  if (!team)
    throw new Error(`the connected Linear account can't see a team with key ${target.team}`);
  let project: LinearProject | undefined;
  if (target.project) {
    const { projects } = await api.get<{ projects: readonly LinearProject[] }>(
      `${path}/linear/projects`,
      { team_id: team.id },
    );
    project = projects.find((candidate) => candidate.name === target.project);
    if (!project) throw new Error(`Linear team ${team.key} has no project named ${target.project}`);
  }
  await api.patch(path, linearIntegrationBody(team, project));

  // Engine files only new issues in Linear; the ones already on the board need adopting.
  const issues = await api.get<readonly { id: string; status: string }[]>("/platform/issues", {
    session_id: sessionId,
    limit: 100,
  });
  const active = issues.filter((issue) => ACTIVE_STATUSES.has(issue.status));
  for (const issue of active) await api.post(`/platform/issues/${issue.id}/linear-sync/retry`, {});
  return `Engine files its issues in Linear (${where}); queued the ${active.length} already on the board`;
}

/** Points the board's Slack and Linear destinations where the config says. Never throws: a problem is a warning. */
export async function ensureIntegrations(
  api: Api,
  sessionId: string,
  integrations: EngineIntegrations,
  log: (line: string) => void,
): Promise<void> {
  const steps: [string, () => Promise<string>][] = [];
  if (integrations.slackChannel) {
    const channel = integrations.slackChannel;
    steps.push(["Slack", () => ensureSlack(api, sessionId, channel)]);
  }
  if (integrations.linear) {
    const target = integrations.linear;
    steps.push(["Linear", () => ensureLinear(api, sessionId, target)]);
  }
  for (const [name, step] of steps) {
    try {
      log(await step());
    } catch (error) {
      log(`WARNING: ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** What keeps the board from reporting where the config says. */
export async function integrationProblems(
  api: Api,
  sessionId: string,
  linear: LinearIntegration | undefined,
  integrations: EngineIntegrations,
): Promise<string[]> {
  const problems: string[] = [];
  if (integrations.slackChannel) {
    const channel = await findSlackChannel(api, integrations.slackChannel);
    const destinations = await api.get<readonly SlackDestination[]>(webhooksPath(sessionId));
    if (!channel || !postsTo(destinations, channel))
      problems.push(`it doesn't post to #${integrations.slackChannel}`);
  }
  const linearIssue = integrations.linear && linearProblem(linear, integrations.linear);
  if (linearIssue) problems.push(linearIssue);
  return problems;
}

export function linearProblem(
  current: LinearIntegration | undefined,
  target: LinearTarget,
): string | null {
  if (linearMatches(current, target)) return null;
  if (!current?.enabled)
    return "Linear sync is off. After a Reset, connect Linear in the board's settings, then re-run mise run demo:install";
  return `it files Linear issues in ${describeLinear(current.team_key ?? "?", current.project_name ?? undefined)}, not ${describeLinear(target.team, target.project)}`;
}
