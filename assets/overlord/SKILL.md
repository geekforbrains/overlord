---
name: overlord
description: Create, modify, diagnose, and synchronize persistent Claude Code and Codex skills and custom agents through their scope-local .agents sources.
---

Use Overlord as the storage and synchronization workflow for persistent skills and custom agents. Its status, check, and sync commands always inspect the user scope and every project discovered beneath the roots in `~/.agents/overlord/overlord.yaml`, regardless of the current working directory.

1. Run `overlord status --json` and inspect every reported scope, definition, action, and diagnostic.
1. Report conflicts, symlinks, and invalid definitions with their `scopePath`, evidence, and filesystem paths. Do not choose a winning side or edit provider-native output to hide an issue.
1. Create or modify requested definitions only in the affected scope's canonical `.agents/skills` or `.agents/overlord/agents` directory. Treat valid native-only definitions only as migration input for Overlord to adopt.
1. Run `overlord sync`. It materializes missing outputs and adopts unambiguous native-only definitions; conflicts and invalid definitions remain untouched.
1. Run `overlord check` and report any remaining issue with its exact scope and paths.

Use provider-native skill and agent authoring guidance for content quality, but keep each scope's physical `.agents` definitions as the only editable source. Managed `.claude` and `.codex` files are generated outputs, and symlinks are unsupported anywhere in managed artifact roots or definitions. Do not infer permission to resolve conflicts, rewrite invalid definitions, delete definitions, or change fleet roots.
