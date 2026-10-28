# desktop-hud

A [claude-hud](https://github.com/jarrodwatts/claude-hud) style HUD for the Claude desktop app. It draws in the band above the prompt and shows:

- model, project, git branch (with a `*` when dirty) and session duration
- context window fill and rate-limit usage bars
- counts of CLAUDE.md files, rules, MCP servers and hooks
- running and recent tools, subagents, and the current todo / plan step

It draws on the desktop surface only; in the terminal, claude-hud's own status line keeps that job.

## Install

At the prompt of a terminal session:

```
/plugin install desktop-hud --marketplace swimricky/claude-desktop-hud
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session, desktop sessions included).

From a shell:

```bash
claude plugin install desktop-hud --marketplace swimricky/claude-desktop-hud
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `swimricky/claude-desktop-hud`, then Add plugin.

This repository is private: installing needs read access on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).
