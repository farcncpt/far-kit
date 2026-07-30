---
name: agent-net
description: Terminal-agent mesh — discover live Claude Code sessions (PID-verified), message them with push delivery at turn boundaries, spawn new terminal agents in any project, and enable Remote Control on running sessions (rc-rescue). Use when coordinating multiple terminal agents, summoning a worker in another project, checking which agents are online, sending a message to another session, or making a running session remote-controllable. Triggers - agent mesh, other agents, live agents, message another agent, spawn agent terminal, summon worker, rc rescue, remote control a running session, agent discovery, inter-agent chat.
---

# agent-net — Terminal Agent Mesh

Hook-driven registration, PID-verified liveness, and push messaging between Claude Code terminal sessions. No tmux, no polling. CLI: `node ~/.claude/agent-net/agent-net.mjs <cmd>` (pre-allowed in permissions — never blocks on approval).

## How it works (you are already on the mesh)

Four hooks in `~/.claude/settings.json` run automatically:
- **SessionStart** — registers this session (name = cwd basename, or `AGENT_NET_NAME` env), injects the live-agent roster + any queued messages
- **UserPromptSubmit** — delivers pending messages with the user's prompt; self-heals registration if missing
- **Stop** — if messages arrived during your turn, your stop is BLOCKED and they're handed to you: handle them, reply if expected, then finish; also self-heals registration
- **SessionEnd** — deregisters

Liveness = `kill(pid, 0)`. A dead session needs no cleanup; dead entries prune on every SessionStart.

## Commands

```bash
AN="node ~/.claude/agent-net/agent-net.mjs"

$AN list                                  # roster: ALIVE/DEAD, name, pid, inbox depth, cwd
$AN send <name> "message" --from <me>     # queue for <name>; delivered at their next turn boundary
$AN spawn <project-path> ["opening prompt"] [flags]   # open a new terminal agent (see below)
$AN rc-rescue <name>                      # enable Remote Control on a RUNNING spawned session
$AN rc-here                               # type /rc into whatever window the USER focused
$AN watch                                 # optional 15s prune daemon (rarely needed)
```

### spawn flags
- `--name <n>` — mesh name + permanent window title `agent:<n>` (enables rc-rescue targeting)
- `--rc` — start remote-controllable (claude.ai / mobile)
- `--auto` — permission-mode auto (workers act without approval prompts; recommended for task agents)
- `--skip-permissions` — full bypass (`--allow-dangerously-skip-permissions`)
- `--continue` — resume most recent conversation in that directory
- `--resume <session-id>` — resume an EXACT conversation (session ids are in `~/.claude/agent-net/state/agents/*.json`)

Each spawn gets its OWN Windows Terminal window with an unforgeable title — that title is what rc-rescue focuses by name.

## agent-com integration

agent-com MCP tools see the mesh: `list_agents` / `discover_live_agents` include live sessions as `net:<name>` (`liveness: "pid-verified"`, instant, no ping). `send_message` to `net:<name>` needs no registration and ALSO pushes into the agent-net inbox (`push_delivery: true`). Use agent-com for channels/jobs/artifacts; agent-net is the delivery + liveness substrate.

## Patterns

**Summon a worker:** `$AN spawn /path/to/project --auto --name fixer "Fix the failing tests in X, then: $AN send <my-name> \"done: <summary>\" --from fixer"` — always give spawned agents an opening prompt that includes how to report back.

**Rescue a forgotten non-RC session (user away):**
1. Spawned window? `$AN rc-rescue <name>` — focuses `agent:<name>`, types `/rc`. Done.
2. Unmarked window/tab? `$AN spawn <project> --rc --resume <session-id>` — same conversation, new RC-enabled body (get the session id from the registry).
3. User at desk? They focus the window, you run `$AN rc-here`.

**Receiving a message (Stop hook fired):** read it, act, reply with `send` if a response is expected, THEN finish your turn. Never ignore it.

## Gotchas

- **Idle sessions can't be woken.** No hook fires at an idle REPL; messages queue and deliver on their next prompt/turn. For urgent work, spawn a fresh worker instead of waiting on an idle one.
- **`/rc` cycles the session id** — the agent drops off the mesh until its next turn boundary re-registers it (self-heal). Expect a brief roster gap after rc-rescue.
- **rc-rescue steals keyboard focus ~2s** — warn the user first if they're present; risk of mis-typed keystrokes if they type mid-rescue.
- **Same-name collisions:** two sessions in same-named dirs share an inbox; `send` reaches the most recently started. Use `--name` for uniqueness.
- **rc-rescue only targets spawned windows** (stable `agent:` titles). Tabs inside a shared window can't be API-focused — that's why spawn forces one window per agent.
- Windows Terminal (`wt.exe`) required for spawn; WSL + Windows only.
