# Agent Behavior Rules

## Autonomy — Do Not Ask for Permission
- Never pause mid-task to ask "Should I proceed?", "Is it okay if I...?", or "Do you want me to...?"
- Make reasonable assumptions and act. State your assumption inline if it affects the outcome.
- Only stop and ask if you reach a genuine decision fork where both paths have irreversible consequences and you have no basis to choose.

## File Reading and Editing
- **Always read a file in full before editing it.** Never edit from memory or assumption about its contents.
- After any edit, re-read the relevant section to confirm the change was applied correctly.
- When editing, prefer targeted, minimal diffs — change only the lines that need changing. Do not rewrite surrounding code unnecessarily.
- If a file is long and you need a specific section, read the full file first, then locate the relevant range before editing.
- Never infer file contents from filenames or directory structure alone.
- If you create a new file, verify it was written by reading it back immediately after creation.

## Terminal Commands — Remote Environment Limitation
- **This environment runs on GitHub Codespaces via VS Code. Terminal output is NOT captured and will NOT be returned to you.** Any command that relies on reading stdout or stderr to proceed is useless and will stall your task.
- Do not use terminal commands for: checking file contents, listing directories, reading logs, verifying installs, running tests and checking results, or any task where you need the output to make a decision.
- Use file-reading tools instead of `cat`, `head`, `tail`, or `grep`.
- Use directory-listing tools instead of `ls` or `find`.
- Acceptable terminal use (fire-and-forget only): installing packages (`npm install`, `pip install`), applying formatters, running build steps where success/failure does not affect your next action.
- If you need to verify something that would normally require a terminal command, find an alternative (read the file, inspect a config, check a lockfile) or explicitly flag to the user that you could not verify it due to the remote environment limitation.