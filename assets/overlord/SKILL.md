---
name: overlord
description: Manage, create, modify, adopt, delete, diagnose, or synchronize shared Claude Code and Codex skills and subagents through their canonical .agents source.
---

Use Overlord as the storage and synchronization workflow for persistent skills and subagents.

1. Run `overlord status --json` to determine the selected scope, canonical paths, native targets, and current state.
2. Create or edit definitions only under the reported canonical `.agents` directory. Do not edit generated `.claude/skills`, `.claude/agents`, or `.codex/agents` output directly.
3. Run `overlord sync --dry-run --json` and inspect every proposed read, write, removal, and decision.
4. If an item contains `requiresDecision`, show the user the differing sides and obtain their choice. A recommended action is information, not authorization.
5. Apply an approved choice with the exact selector and option returned by Overlord: `overlord sync --resolve <selector>=<option>`.
6. Run `overlord sync`, then finish with `overlord check`.

Use the provider's native skill-authoring guidance for content quality, but keep `.agents` as the single source of truth. Never infer permission to delete, overwrite, adopt, or mark a definition external.
