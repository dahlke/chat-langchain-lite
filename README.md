# Chat LangChain Lite

A small LangChain docs assistant that Deployed Engineers use to demo LangSmith. It runs as a TypeScript [Managed Deep Agent](https://docs.langchain.com/langsmith/javascript/managed-deep-agents-quickstart) with a React chat app on GitHub Pages.

## Use the shared demo

This repo deploys one shared demo to LangChain's demo workspace, and the app runs at <https://langchain-samples.github.io/chat-langchain-lite/>. Demo from it rather than installing your own copy: GitHub Actions keep it ready, with fresh traffic, pre-run experiments and Engine's verified fixes.

LangChain employees: the [Demo Guide](https://app.notion.com/p/40d808527b1780a294dbfa6706f82681) has the demo paths, a feature tour and an FAQ.

Fork only to build a change you mean to merge back. See [Contributing](#contributing).

## Repo layout

```
agent/   Managed Deep Agent (deployed with mda)
web/     Vite+ / React / Macaw chat app (GitHub Pages)
evals/   eval dataset, hosted evaluators and the demo prepare step
scripts/ setup and deploy helpers
```

`agent/`, `web/` and `evals/` share one pnpm workspace. `agent/` must never contain a lockfile: `mda` copies the folder into its build, and a lockfile there breaks LangSmith's builder.

## Quick start

Prerequisite: [mise](https://mise.jdx.dev). It installs Node, pnpm, `gh`, `lefthook`, and the `langsmith` CLI.

```bash
mise install
mise run setup        # installs deps and git hooks, creates agent/.env
```

Then:

1. Put your LangSmith personal access token in `agent/.env` as `LANGSMITH_API_KEY`. On an MDM-managed Mac, `setup` fills `LANGSMITH_GATEWAY_API_KEY` from `LC_GATEWAY_KEY`; otherwise paste your LangChain Inc Gateway key.
2. Add your workspace to `mise.local.toml` (git-ignored):

   ```toml
   [env]
   LANGSMITH_WORKSPACE_ID = "<your workspace id>"
   ```

3. Run it:

   ```bash
   mise run dev          # agent on http://localhost:2024, app on http://localhost:5173
   ```

`mda dev` verifies "Sign in with LangSmith" tokens too, so set up [local sign-in](#sign-in-with-langsmith) first. Personal access tokens work only against deployed agents, which check them through LangSmith.

## Tasks

| Task | What it does |
|---|---|
| `mise run setup` | Install dependencies and git hooks, create `agent/.env` |
| `mise run dev` | Run the agent and the web app locally |
| `mise run check` | Format check, lint and typecheck |
| `mise run test` | Unit tests |
| `mise run demo:prepare` | Seed the eval dataset, create the hosted evaluators, triage queue and its custom app, send sample traffic, and pre-run the experiments |
| `mise run demo:install` | Set up, create both environments as GitHub-connected deployments, turn on previews and Engine fix verification, publish Pages, then run `demo:prepare` |
| `mise run demo:trickle` | Send a few conversations with feedback to production, as the Trickle workflow does |
| `mise run demo:check` | Check the deployed demo end to end, as the Health workflow does |
| `mise run demo:reset` | Show what a reset would do. `--yes` closes Engine's fix PRs, replaces its board and refreshes the experiments |
| `mise run demo:uninstall` | List everything the demo created in the workspace. `--yes` deletes it |

## Evals

`mise run demo:prepare` (or **Actions → Prepare demo**) gets a workspace ready for the demo. It's safe to re-run; finished work is skipped.

1. Seeds the `chat-langchain-lite` dataset from `evals/dataset/examples.json`. Each example is a question plus assertions a correct answer must satisfy.
2. Creates the hosted evaluators: the built-in Assertions judge, a Jev decision model for tone, a gpt-6-luna tone judge (`professional_tone_llm`) with an alignment queue for tuning it against human labels (on for experiments, attached but off for traces; its runs are traced, so each score links to the judge's reasoning), a JavaScript check that answers cite the docs they searched, and LangSmith's Trajectory Accuracy judge on both tracing projects. It also creates a triage annotation queue that collects thumbs-down answers, and pushes [`triage-sheet/`](triage-sheet/README.md), a custom app that shows that queue as a spreadsheet. The dataset, queue, evaluators and their prompts are tagged to the `chat-langchain-lite` agent, so they show up under it in LangSmith.
3. Sends sample questions to `production`.
4. Pre-runs three experiments: production, development, and development with gpt-6-luna.

Use `--only <steps>`, `--split demo` and `--roles <roles>` to run part of it. It needs `LANGSMITH_API_KEY` (from `agent/.env` or a repo secret), `LANGSMITH_WORKSPACE_ID`, both environments deployed, `development` ahead of `main` (it warns otherwise), and an `LC_GATEWAY_KEY` secret (organization or workspace) for the tone evaluators.

## How deploys work

One agent, `chat-langchain-lite`, per workspace, with two environments. Both are GitHub-connected deployments: LangSmith rebuilds `agent/` from the environment's branch on every push.

| Environment | Builds from | Deployment type |
|---|---|---|
| `production` | `main` | `PRODUCTION_DEPLOYMENT_TYPE` when install creates it (default `dev`) |
| `development` | `development` | `dev` |

LangSmith builds whether or not CI passed, so `main` and `development` are protected: merging a pull request needs a passing `check`. Admins can still push directly.

Each build syncs `agent/instructions.md` and `agent/skills/` to a Context Hub repo named after the deployment, with git winning. The Gateway key, the CORS allow-list and the sign-in settings are deployment secrets. `mise run demo:install` sets them, but sets the Gateway key only when it creates a deployment; after that, the Sync Gateway key workflow copies it from the `LANGSMITH_GATEWAY_API_KEY` repo secret.

`development` runs one commit ahead of `main` on purpose, so the demo has a candidate to compare against production. To release it, open a pull request from `development` into `main` and merge it with a merge commit. A squash merge leaves `development` looking ahead with nothing new. After anything lands on `main` directly, merge `main` back into `development`.

A pull request into `development` labeled `preview` gets its own preview deployment. It's torn down when the pull request closes. Engine labels its fix pull requests this way, replays the issue's production traces against `development` and the preview, and shows on its board whether the fix worked.

The deployment type is fixed when a deployment is first created. Changing it later means deleting and recreating the deployment.

## Contributing

Build changes in a fork, test them in your own LangSmith workspace, then open a pull request into this repo's `main`. The steps below install a full copy of the demo in that workspace. Don't point a fork at the shared demo's workspace.

1. Fork this repo with **Copy the `main` branch only** unchecked, so you get `development` too. For a fork that only has `main`, add the original repo as the `upstream` remote and run `git fetch upstream development && git push origin upstream/development:development`.
2. In LangSmith, start a new deployment from GitHub and give LangSmith's GitHub App access to your fork. You can cancel before creating the deployment.
3. Run `mise run demo:install`. It needs `gh` signed in and `agent/.env` filled in. It:
   - sets the `LANGSMITH_API_KEY` repo secret if it's missing, and the `LANGSMITH_WORKSPACE_ID` variable
   - protects `main` and `development`, and turns on GitHub Pages
   - creates both environments as GitHub-connected deployments and waits for their first build
   - sets the `VITE_AGENT_URL_DEVELOPMENT` and `VITE_AGENT_URL_PRODUCTION` variables, plus `VITE_LANGSMITH_ORGANIZATION_ID`, `VITE_LANGSMITH_SSO_SLUG` when the org uses SSO, and `VITE_OAUTH_CLIENT_ID` when `agent/.env` has one
   - turns on previews for `development`
   - creates the `maintainers` environment, so the Reset and Teardown workflows wait for your approval
   - turns on issues, where the Health workflow reports problems
   - publishes Pages and runs `demo:prepare`, creating the Engine board on production after its traffic so the first scan has traces to read (see [Engine fix verification](#engine-fix-verification))
   - points the board at the Slack channel and Linear project in `agent/.env`, if any, and copies them to repo variables (see [Engine in Slack and Linear](#engine-in-slack-and-linear))

   Re-running skips what's done, but updates the deployments' secrets when they change; `--redeploy` rebuilds both environments. A workspace whose environments were deployed with the mda CLI needs `--replace` once: it deletes them and creates them again from GitHub, keeping their tracing projects and rules.
4. Your app is at `https://<you>.github.io/<repo>/`.

### Sign in with LangSmith

The app signs people in with their LangSmith account, and keeps personal access tokens as a fallback. Both stay in the browser tab and go only to your agent and to the LangSmith API.

1. Ask an org admin to register an OAuth app under **Settings → OAuth applications**: type **Public**, redirect URIs `https://<you>.github.io/<repo>/` (trailing slash included) and `http://localhost`, scopes `openid`, `email`, `profile` and `offline_access`. It needs the org's `sign_in_with_langsmith` flag.
2. Put its client id (`lsc_…`) in `agent/.env` as `OAUTH_CLIENT_ID` and re-run `mise run demo:install`.

LangSmith lets any of its users approve the app, so the agent runs only for tokens issued to this app for members of your org. Thread reads, updates and deletes are scoped to the token's user instead: a person's token from another OAuth app reaches only that person's own threads. People in several orgs choose one on LangSmith's consent page; if they choose another, the app sends them back to choose again. The consent page lists only the orgs of the account they're signed in to LangSmith with. When the org uses SSO, sign-in goes through its SSO login first, which also switches a LangSmith session signed in with another account; otherwise people sign out of LangSmith and back in with the right login. The sign-in screen remembers the last account's email (no tokens) in `localStorage`. Keys reach the agent through LangSmith's own check of the workspace, the way Studio and Engine call it. People who sign in with a key see only their own threads in the app; the API would let them read everyone's.

For local sign-in, put `VITE_OAUTH_CLIENT_ID=lsc_…`, `VITE_LANGSMITH_ORGANIZATION_ID` and `VITE_LANGSMITH_SSO_SLUG` (if any) in `web/.env.development.local`, and `OAUTH_CLIENT_ID` and `ALLOWED_ORGANIZATION_ID` in `agent/.env`.

### Engine fix verification

Install creates the Engine board on the `chat-langchain-lite-production` tracing project, which starts a paid scan. The board scans daily at the reduced level, up to 250 LCU a month, fixes `agent/` against `development`, and verifies each fix on its PR's preview. Before installing, install Engine's GitHub App on your fork. It's a separate app from the deployments' one, and needs write access to checks, issues and pull requests.

Fix verification needs the `enable_engine_issue_validation` flag on the workspace.

Engine's fix PRs can't be merged: the `merge-guard` check stays pending on them. Show the verdict instead.

### Engine in Slack and Linear

Engine can post each new issue and fix PR to a Slack channel, and file each issue as a Linear ticket. Both are optional and set in `agent/.env`:

- `ENGINE_SLACK_CHANNEL`: a public channel in a Slack workspace connected to the LangSmith org.
- `ENGINE_LINEAR_TEAM` and, optionally, `ENGINE_LINEAR_PROJECT`: the team's key and a project name. First connect Linear in the Engine board's settings in LangSmith; only the UI can.

Install and Reset point the board at them; Health checks it does. Deleting the board deletes its Linear connection, so after a Reset, connect Linear again and re-run `mise run demo:install`. Health fails until you do.

## Keeping the demo running

Once installed, GitHub Actions keep the demo ready. They use the `LANGSMITH_API_KEY` repo secret; for a shared demo, make it a service key with the Editor role on the demo's workspace only.

| Workflow | When | What it does |
|---|---|---|
| Trickle | Every 4 hours | A few conversations with production, some with a follow-up and feedback, so there are always recent traces and evidence for Engine |
| Health | Daily | Checks the deployments, sign-in, Pages, the tone judge, Engine and its Slack and Linear destinations, and the schedules. While anything fails, one issue labeled `demo-health` stays open |
| Reset | By hand, after approval | Closes Engine's fix PRs, replaces its board with its Slack and Linear destinations, sends traffic and refreshes the experiments. `main` and `development` stay as they are |
| Teardown | By hand, after approval | Runs `demo:uninstall --yes` |
| Prepare demo | By hand | Runs `demo:prepare` |
| Sync Gateway key | By hand, after approval | Copies the `LANGSMITH_GATEWAY_API_KEY` repo secret into both deployments, rebuilding any that change, then runs Health |

Reset and Teardown take a typed confirmation and wait in the `maintainers` environment for approval. Other people may be mid-demo, so tell them first. To get Health's alerts in Slack, run `/github subscribe <owner>/<repo> issues +label:"demo-health"` in a channel.

## Uninstall

`mise run demo:uninstall` lists everything the demo created in the workspace, with what each evaluator is attached to. `mise run demo:uninstall -- --yes` deletes it in dependency order, re-checks, and lists what to remove by hand on GitHub and locally. It deletes only evaluators the demo created, and keeps the `LC_GATEWAY_KEY` secret and the `user_score` and `answer_ok` feedback configs, which other apps share.

## License

MIT. See [LICENSE](LICENSE).
