import { describe, expect, it } from "vitest";

import { ApiError } from "../src/api.ts";
import {
  ensureIntegrations,
  integrationProblems,
  linearProblem,
  readIntegrations,
  slackDestinationBody,
} from "../src/engine-integrations.ts";
import { fakeApi, type Call } from "./fake-api.ts";

const board = "/platform/sessions/session-1/issues-agent";
const team = {
  id: "team-1",
  name: "Deployed Eng",
  key: "DEP",
  workspace_id: "ws-1",
  workspace_name: "LangChain",
};
const linearOn = { enabled: true, team_key: "DEP", project_name: "demo" };

function slackApi(destinations: unknown[], channels: (refresh: boolean) => unknown[]) {
  return fakeApi((call: Call) => {
    if (call.path === "/platform/slack/installations") return [{ team_id: "T1" }];
    if (call.path === "/platform/slack/installations/T1/channels")
      return channels(Boolean((call.query as { refresh?: boolean } | undefined)?.refresh));
    if (call.path === `${board}/webhooks` && call.method === "GET") return destinations;
    return {};
  });
}

describe("readIntegrations", () => {
  it("skips blank parts and normalizes the channel and team key", () => {
    expect(readIntegrations({})).toEqual({});
    expect(
      readIntegrations({
        ENGINE_SLACK_CHANNEL: " #proj-demo ",
        ENGINE_LINEAR_TEAM: "dep",
        ENGINE_LINEAR_PROJECT: "demo",
      }),
    ).toEqual({ slackChannel: "proj-demo", linear: { team: "DEP", project: "demo" } });
  });

  it("rejects a project without its team", () => {
    expect(() => readIntegrations({ ENGINE_LINEAR_PROJECT: "demo" })).toThrow("ENGINE_LINEAR_TEAM");
  });
});

describe("slackDestinationBody", () => {
  it("posts every severity, for new issues and fix PRs", () => {
    expect(slackDestinationBody({ teamId: "T1", channelId: "C1" })).toEqual({
      slack_team_id: "T1",
      slack_channel_id: "C1",
      severity_threshold: 3,
      event_types: ["issue.created", "issue.fix_pr.opened"],
    });
  });
});

describe("ensureIntegrations: Slack", () => {
  it("adds the channel, refreshing LangSmith's cached channel list to find a new one", async () => {
    const api = slackApi([], (refresh) => (refresh ? [{ id: "C1", name: "proj-demo" }] : []));
    await ensureIntegrations(api, "session-1", { slackChannel: "proj-demo" }, () => {});
    const posts = api.calls.filter((call) => call.method === "POST");
    expect(posts).toEqual([
      {
        method: "POST",
        path: `${board}/webhooks`,
        body: expect.objectContaining({ slack_channel_id: "C1" }),
      },
    ]);
  });

  it("doesn't add the channel twice", async () => {
    const api = slackApi([{ destination_type: "slack", slack_channel_id: "C1" }], () => [
      { id: "C1", name: "proj-demo" },
    ]);
    await ensureIntegrations(api, "session-1", { slackChannel: "proj-demo" }, () => {});
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("warns instead of failing when the channel can't be found", async () => {
    const lines: string[] = [];
    const api = slackApi([], () => []);
    await ensureIntegrations(api, "session-1", { slackChannel: "nope" }, (line) =>
      lines.push(line),
    );
    expect(lines).toEqual([
      "WARNING: Slack: #nope isn't a public channel LangSmith's Slack app can see",
    ]);
  });
});

describe("ensureIntegrations: Linear", () => {
  const target = { linear: { team: "DEP", project: "demo" } };

  it("leaves a board that already files in the right project alone", async () => {
    const api = fakeApi(() => ({ linear_integration: linearOn }));
    await ensureIntegrations(api, "session-1", target, () => {});
    expect(api.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("turns sync on, then queues the issues already on the board", async () => {
    const api = fakeApi((call) => {
      if (call.path === board) return {};
      if (call.path === `${board}/linear/teams`) return { teams: [team] };
      if (call.path === `${board}/linear/projects`)
        return { projects: [{ id: "p-1", name: "demo" }] };
      if (call.path === "/platform/issues")
        return [
          { id: "i-open", status: "open" },
          { id: "i-done", status: "completed" },
        ];
      return { status: "queued" };
    });
    await ensureIntegrations(api, "session-1", target, () => {});
    const writes = api.calls.filter((call) => call.method !== "GET");
    expect(writes).toEqual([
      {
        method: "PATCH",
        path: board,
        body: {
          linear_integration: {
            enabled: true,
            workspace_id: "ws-1",
            workspace_name: "LangChain",
            team_id: "team-1",
            team_name: "Deployed Eng",
            team_key: "DEP",
            project_id: "p-1",
            project_name: "demo",
          },
        },
      },
      { method: "POST", path: "/platform/issues/i-open/linear-sync/retry", body: {} },
    ]);
  });

  it("warns that Linear needs connecting when the board has no Linear account", async () => {
    const lines: string[] = [];
    const api = fakeApi((call) => {
      if (call.path === `${board}/linear/teams`)
        throw new ApiError(409, call.path, "Connect a Linear account and retry");
      return {};
    });
    await ensureIntegrations(api, "session-1", target, (line) => lines.push(line));
    expect(lines).toEqual([expect.stringContaining("Linear isn't connected to the Engine board")]);
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});

describe("linearProblem", () => {
  const target = { team: "DEP", project: "demo" };

  it("passes the configured team and project", () => {
    expect(linearProblem(linearOn, target)).toBeNull();
  });

  it("asks for a reconnect when sync is off, as after a Reset", () => {
    expect(linearProblem({ enabled: false }, target)).toMatch(/^Linear sync is off/);
    expect(linearProblem(undefined, target)).toMatch(/^Linear sync is off/);
  });

  it("names the wrong destination", () => {
    expect(linearProblem({ ...linearOn, project_name: null }, target)).toBe(
      "it files Linear issues in DEP, not DEP / demo",
    );
  });
});

describe("integrationProblems", () => {
  it("reports a board that doesn't post to the channel", async () => {
    const api = slackApi([], () => [{ id: "C1", name: "proj-demo" }]);
    expect(
      await integrationProblems(api, "session-1", undefined, { slackChannel: "proj-demo" }),
    ).toEqual(["it doesn't post to #proj-demo"]);
  });
});
