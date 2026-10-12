# karea-agentic

[Karea](https://karea.app) for Claude Code: mods, skills and plugins.

## Install

```
/plugin marketplace add starecz/karea-agentic
/plugin install karea@karea-agentic
```

## Plugins

| Plugin | What it does |
| --- | --- |
| `karea` | Shows whether your active Karea task is in sync with the session: hint-line chip, "behind" band with Sync now, changed-in-Karea alerts, task pane and a `/ksync` command. Includes the Karea skill. |

### How `karea` works

- **Active task.** `/ksync pick KA123`, or automatic: a session started from Karea Connect (env var `KAREA_TASK`) picks its task, and a resumed session gets back the task it had.
- **Changed in Karea.** While you are active it asks Karea what changed on the task since its last check (`karea_task_changes`, only edits by people in the browser or through Karea AI). After a gap of over an hour it re-reads the task once. Servers without `karea_task_changes` fall back to comparing task snapshots.
- **Open subtasks.** If closing the task is refused because it has open subtasks, you are asked whether to close them too, and Claude gets your answer.

## Develop

```
claude plugin validate plugins/karea
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/karea
```

## License

MIT, see [LICENSE](LICENSE).
