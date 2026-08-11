---
name: overlord
description: Create, modify, diagnose, and synchronize persistent Claude Code and Codex skills and custom agents through their scope-local .agents sources.
---

Use Overlord as the storage and synchronization workflow for persistent skills and custom agents. Its status, check, and sync commands always inspect the user scope and every project discovered at or beneath the roots in `~/.agents/overlord/overlord.yaml`, regardless of the current working directory.

1. Run `overlord status --json` and inspect every reported scope, definition, action, and diagnostic.
1. Report conflicts, symlinks, and invalid definitions with their `scopePath`, evidence, and filesystem paths. Do not choose a winning side or edit files merely to hide an issue.
1. Create or intentionally modify requested definitions in the affected scope's `.agents/skills` or `.agents/overlord/agents` directory. Do not move a project definition into the user scope or another project.
1. Run `overlord sync`. It uses the last-synchronized state to reconcile unambiguous canonical or provider additions, edits, and deletions within each scope; concurrent incompatible changes remain untouched.
1. Run `overlord check` and report any remaining issue with its exact scope and paths.

Use provider-native skill and agent authoring guidance for content quality. Each scope's physical `.agents` definitions are canonical after synchronization, while tracked `.claude` and `.codex` files may supply provider-originated changes. Overlord creates deterministic Git commits only in the user source at `~/.agents`; it never commits a project repository or relies on an agent to compose commits. Symlinks are unsupported anywhere in managed artifact roots or definitions. Do not infer permission to resolve conflicts, rewrite invalid definitions, delete definitions, or change fleet roots.
