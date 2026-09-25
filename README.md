# Pi Subagents

An installable Pi package that lets the main agent autonomously delegate work to specialized, process-isolated subagents.

## Included agents

| Agent | Role | Model | Thinking | Tools |
|---|---|---|---|---|
| `scout` | Fast codebase reconnaissance | `openai-codex/gpt-6-luna` | `low` | `read`, `grep`, `find`, `ls` |
| `reviewer` | Independent correctness, security, and performance review | `openai-codex/gpt-6-sol` | `xhigh` | `read`, `grep`, `find` |
| `worker` | Simple, high-performance autonomous implementation | `openai-codex/gpt-6-luna` | `xhigh` | all coding and search tools |

The target machine must have authentication and model access configured for these models. You can override any bundled agent without modifying the package; see [Agent overrides](#agent-overrides).

## Install

### From Git

Push this repository to a Git host, tag a release, and install it globally:

```bash
pi install git:github.com/nginatta-fai/pi-subagents@0.2.1
```

A raw Git URL also works:

```bash
pi install https://github.com/nginatta-fai/pi-subagents@0.2.1
```

Use `-l` to record the package in the current project's `.pi/settings.json` instead of global settings:

```bash
pi install git:github.com/nginatta-fai/pi-subagents@0.2.1 -l
```

After changing installed resources, start a new Pi session or run `/reload`.

### From a local checkout

```bash
pi install .
```

A local install references this directory in Pi settings; it does not copy it. For a one-off development run without modifying settings:

```bash
pi --no-extensions -e ./extensions/subagents/index.ts
```

### From npm

After publishing the package:

```bash
pi install npm:pi-subagents@0.2.1
```

Inspect and manage installations with:

```bash
pi list
pi config
pi remove git:github.com/nginatta-fai/pi-subagents
```

> Pi extensions execute with the full operating-system permissions of the Pi process. Review packages before installing them.

## How it works

[`extensions/subagents/index.ts`](extensions/subagents/index.ts) registers a `subagent` tool. Its tool description contains the live agent catalogue, allowing the main model to select and invoke a role without the user explicitly requesting delegation.

Each invocation starts a separate ephemeral Pi process with:

- the agent's model and thinking level
- an exact tool allowlist
- the Markdown body of its agent file appended as its role prompt
- no discovered extensions, skills, or prompt templates
- no persisted child session
- JSON event streaming back to the parent tool UI

Subagent output and model usage are returned to the parent. Model-visible output is capped at 50 KiB; larger complete output is written to a private temporary file that is removed at session shutdown. Child cancellation propagates to the process tree. Mutating agents are serialized.

Use `/subagents` to enable or disable individual agents, or `/subagents list` to inspect the catalogue and enabled state.

While `worker` is enabled, the routing policy makes it the default executor for non-trivial implementation, fixes, refactors, and other code changes. Requests referring to prior findings by severity or item number should be delegated with those finding details copied into the isolated worker task. The main agent may implement directly only for trivial one-line changes or when explicitly told not to use subagents. Disabling `worker` removes that delegation requirement and allows the main agent to implement directly.

The main agent can invoke subagents autonomously. Example prompts that exercise routing:

```text
Explain how this project works and identify its main risks.
Review the current implementation for correctness, security, and performance.
Add a focused feature to this project and validate it.
```

For deterministic smoke tests, request roles directly:

```text
Use the scout to map this repository.
Use the reviewer to review extensions/subagents/index.ts.
```

## Toggle subagents

Run `/subagents` to open a searchable picker similar to `/scoped-models`:

| Default key | Action |
|---|---|
| Up / Down | Select an agent |
| Enter | Toggle the selected agent |
| Type | Search names, descriptions, and models |
| Ctrl+A | Enable all agents matching the search (all agents when empty) |
| Ctrl+X | Disable all agents matching the search (all agents when empty) |
| Ctrl+S | Save the selection as defaults for new sessions |
| Escape | Close, keeping the current selection |
| Ctrl+C | Clear the search, or close when empty |

The picker respects Pi's selection and scoped-model keybindings. Changes apply immediately and are stored on the current session branch, surviving `/reload`, resume, and fork. Navigating the session tree restores that branch's selection.

Only enabled agents appear in the tool's catalogue and argument schema. Disabled agents cannot start new invocations, including invocations still waiting in the writer queue; already-running subagents are not cancelled. Disabling every agent removes the `subagent` tool until an agent is re-enabled, without changing other active tools.

All agents are enabled by default. Ctrl+S writes `disabledAgents` to `~/.pi/agent/subagents.json` (or the directory set by `PI_CODING_AGENT_DIR`). Session selections take precedence over saved defaults. Names are shared across bundled, user, and project overrides; newly discovered names are enabled unless explicitly disabled. Invalid saved configuration produces a warning and disables agents unless the current branch has a valid selection.

`/subagents list` shows enabled/disabled status without opening the picker. Outside TUI mode, `/subagents` also uses this listing behavior.

## Package structure

```text
pi-subagents/
├── package.json
├── README.md
└── extensions/
    └── subagents/
        ├── index.ts
        ├── agents.ts
        ├── selection.ts
        ├── selector.ts
        └── agents/
            ├── scout.md
            ├── reviewer.md
            └── worker.md
```

`package.json` declares the extension through `pi.extensions`. The agent Markdown files are bundled beside the extension and discovered relative to the installed package, so they work from npm, Git, and local-path installations.

## Agent overrides

Agents are loaded in this order, with later definitions overriding earlier agents that have the same `name`:

1. Package defaults in `extensions/subagents/agents/`
2. User overrides in `~/.pi/agent/agents/*.md`
3. Trusted project overrides in `.pi/agents/*.md`

This lets you change models, thinking levels, tools, or prompts without forking the package. For example, create `~/.pi/agent/agents/scout.md`:

```markdown
---
name: scout
description: Fast, read-only codebase reconnaissance
model: another-provider/another-model
thinking: low
tools: [read, grep, find, ls]
mutating: false
---

Your replacement scout system prompt goes here.
```

Project agents load only when the project is trusted. Run `/reload` after adding or changing an override so the main agent's displayed catalogue is refreshed.

## Agent format

```markdown
---
name: example
description: Short routing description shown to the main model
model: provider/model-id
thinking: medium
tools: [read, grep, find, ls]
mutating: false
---

The role-specific system prompt goes here.
```

- Omitting `model` or `thinking` inherits the parent session's current value.
- Omitting `tools` uses Pi's defaults; `tools: []` enables no tools.
- Agents with `mutating: true` are queued so two writers do not run simultaneously.
- Agents with `bash`, `powershell`, `edit`, or `write` are always treated as mutating, even if their frontmatter says otherwise.
- Child Pi processes use `--no-extensions`, preventing recursive delegation and inherited extension loading.

Tool allowlists are capability controls for Pi tools, but a worker with `bash` still has the operating-system permissions of the parent Pi process. Use a sandbox or container when stronger isolation is required.

## Development

```bash
npm install --ignore-scripts
npm run check
npm test
```

Tests cover the picker, saved and branch-local selections, dynamic tool routing, and dispatch guards without making model requests.
