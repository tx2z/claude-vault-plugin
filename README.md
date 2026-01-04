# Claude Vault

<p align="center">
  <img src=".github/assets/obsidian-claude-love.png" alt="Obsidian + Claude = Love" width="400">
</p>

An AI-assisted knowledge base for Obsidian. A hybrid system where you have visual access through Obsidian, and your AI assistant has access through Claude Code. Work from your phone, desktop, or terminal — everything stays in sync.

## What You Can Do

- **Keep your notes** — everything in markdown, organized your way
- **Give AI access to your knowledge** — Claude can read, search, and build on your notes
- **Manage tasks and projects** — with an AI executive assistant
- **Store artifacts** — code, files, research outputs — all in project folders
- **Run deep research** — similar to Deep Research, with results saved to your vault
- **Sync across devices** — mobile, desktop, terminal — always up to date

## How It Works

You interact through Obsidian (or any markdown editor). Claude interacts through Claude Code. Both work on the same files.

**Zero Git knowledge required.** All changes sync automatically to the main branch. Multiple agents can work in parallel — conflicts are resolved automatically.

## Setup

### 1. Fork this repository

Click "Fork" on GitHub to create your own copy.

### 2. Connect Claude Code

- You need a [Claude Pro/Team subscription](https://claude.ai)
- Open Claude → Claude Code tab
- Connect your GitHub account
- Select your forked repository when starting a session

### 3. Add GitHub Token

For Claude to sync changes to your repository, add a GitHub token:

1. [Create a Personal Access Token](https://github.com/settings/tokens/new) with `repo` scope
2. In Claude Code settings, add environment variable:
   ```
   GH_TOKEN=your_token_here
   ```

Claude will guide you through onboarding.

### 4. Open in Obsidian

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
```

Open the cloned folder in [Obsidian](https://obsidian.md) as a vault.

## Local Sync

Obsidian doesn't sync with Git automatically. After making local changes, run:

```bash
./cli.sh sync
```

Or via Claude CLI:

```bash
claude -p "./cli.sh sync"
```

This commits and pushes everything to main.

## Structure

```
├── CLAUDE.md      # Agent instructions
├── AGENDA.md      # Current context and open threads
├── 0-Inbox/       # Quick capture
├── 1-Projects/    # Active work with artifacts
├── 2-Areas/       # Life areas (health, career, etc.)
├── 3-Resources/   # Reference material
├── 4-Archive/     # Completed items
└── Daily/         # Daily notes
```

## License

MIT
