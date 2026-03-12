---
name: skill-manager
description: Search, install, uninstall, list, inspect, and create agent skills from local paths, GitHub URLs, the skills.sh ecosystem, or the anthropics/skills registry. Use when the user wants to manage skills, find a skill, install a new skill, remove a skill, browse installed skills, create a new skill, or pastes a GitHub URL containing a SKILL.md file. Also triggers when the user says "find skill", "search skill", "install skill", "add skill", "remove skill", "list skills", "show skills", "create skill", "new skill", "is there a skill for", or mentions skill management in any way.
---

# Skill Manager

Manage skills across two scopes:

| Scope | Path | Visibility |
|-------|------|------------|
| **User** | `~/.claude/skills/<name>/` | All projects |
| **Project** | `.claude/skills/<name>/` | Current project only |

Default scope is **user** unless the user specifies project-level.

## Search

Find skills from the open skills ecosystem via [skills.sh](https://skills.sh/):

```bash
npx skills find [query]
```

Map user intent to search keywords:

| User says | Search query |
|-----------|-------------|
| "help me review PRs" | `npx skills find pr review` |
| "make my React app faster" | `npx skills find react performance` |
| "I need to create a changelog" | `npx skills find changelog` |

Present results with skill name, description, and install command. If no results, offer to help directly and suggest creating a custom skill.

## Install

Determine the source type and follow the corresponding flow.

### From local path

```bash
# Validate source has SKILL.md
ls "$SOURCE_PATH/SKILL.md"

# Copy to skills directory
cp -r "$SOURCE_PATH" ~/.claude/skills/<name>/
```

If the source is a single SKILL.md file (not a directory), create the skill directory and copy it in:

```bash
mkdir -p ~/.claude/skills/<name>/
cp "$SOURCE_PATH" ~/.claude/skills/<name>/SKILL.md
```

### From GitHub URL

Supports these URL patterns:
- `https://github.com/<owner>/<repo>` — clone whole repo, look for SKILL.md at root or in `skills/` subdirectories
- `https://github.com/<owner>/<repo>/tree/<branch>/<path>` — sparse checkout of specific directory
- `https://github.com/<owner>/<repo>/blob/<branch>/<path>/SKILL.md` — download single file via raw URL

**Standard flow:**

```bash
# Clone to temp directory
TEMP=$(mktemp -d)
git clone --depth 1 "$REPO_URL" "$TEMP/repo"

# Find SKILL.md files
find "$TEMP/repo" -name "SKILL.md" -maxdepth 3
```

If one SKILL.md found at root, copy the whole repo as the skill. If multiple found (monorepo with multiple skills), list them and ask the user which to install.

**For a specific subdirectory (tree URL):**

Parse the URL to extract `REPO_URL` (e.g. `https://github.com/owner/repo`) and `SUBPATH` (the path after `/tree/<branch>/`).

```bash
TEMP=$(mktemp -d)
git clone --depth 1 --filter=blob:none --sparse "$REPO_URL" "$TEMP/repo"
cd "$TEMP/repo" && git sparse-checkout set "$SUBPATH"
cp -r "$SUBPATH" ~/.claude/skills/<name>/
rm -rf "$TEMP"
```

**For a raw SKILL.md URL:**

```bash
mkdir -p ~/.claude/skills/<name>/
curl -fsSL "$RAW_URL" -o ~/.claude/skills/<name>/SKILL.md
```

Convert GitHub blob URLs to raw URLs: replace `github.com` with `raw.githubusercontent.com` and remove `/blob/`.

Always clean up temp directories after install: `rm -rf "$TEMP"`

### From skills.sh ecosystem

Install a skill found via `npx skills find`:

```bash
npx skills add <owner/repo@skill> -g -y
```

`-g` installs globally (user-level), `-y` skips confirmation.

### From .skill file

A `.skill` file is a zip archive produced by `package_skill.py`.

```bash
TEMP=$(mktemp -d)
unzip "$SKILL_FILE" -d "$TEMP"
# The zip contains a single top-level directory named after the skill
SKILL_DIR=$(ls "$TEMP")
cp -r "$TEMP/$SKILL_DIR" ~/.claude/skills/<name>/
rm -rf "$TEMP"
```

### From anthropics/skills registry

Browse and install from `github.com/anthropics/skills`:

```bash
# List available skills
gh api repos/anthropics/skills/contents/skills --jq '.[].name'

# Preview a skill
gh api repos/anthropics/skills/contents/skills/<name>/SKILL.md --jq '.content' | base64 --decode

# Install (clone + copy to avoid issues with subdirectories)
TEMP=$(mktemp -d)
git clone --depth 1 https://github.com/anthropics/skills.git "$TEMP/repo"
cp -r "$TEMP/repo/skills/<name>" ~/.claude/skills/<name>/
rm -rf "$TEMP"
```

If the user just says "install skill" without specifying which, list popular skills from the registry and let them pick.

### Post-install validation

After copying files, always validate:

1. `SKILL.md` exists in the target directory
2. Has valid YAML frontmatter (between `---` markers)
3. Frontmatter contains `name` and `description`
4. Report: skill name, description, scope, and installed path

## Update

Re-install from the original source to update a skill. Follow the same install flow — when the skill already exists, overwrite after confirming with the user.

## Uninstall

Always confirm with the user before deleting. Show the skill's name and description first.

```bash
# Verify target is inside a skills directory before removing
TARGET=~/.claude/skills/<name>  # or .claude/skills/<name>
[[ "$TARGET" == */.claude/skills/* ]] && [ -f "$TARGET/SKILL.md" ] && rm -rf "$TARGET"
```

## List

Scan both scopes and display each skill's name, description, and scope:

```bash
# User-level skills
for d in ~/.claude/skills/*/; do
  [ -f "$d/SKILL.md" ] && echo "$(basename $d) [user] $d"
done

# Project-level skills
for d in .claude/skills/*/; do
  [ -f "$d/SKILL.md" ] && echo "$(basename $d) [project] $d"
done
```

For each found skill, read the first few lines of SKILL.md to extract `name` and `description` from frontmatter. Present as a formatted table.

## Info

Show full details of a specific skill:

1. Read and display the YAML frontmatter fields
2. Show the directory contents (`ls -la`)
3. Show the first 30 lines of the SKILL.md body (after frontmatter)
4. Report file sizes of any bundled scripts/references/assets

## Create

When the user wants to create a new skill, check if `skill-creator` is installed:

```bash
[ -d ~/.claude/skills/skill-creator ] || [ -d .claude/skills/skill-creator ]
```

If not installed, recommend installing the official one first:

```bash
TEMP=$(mktemp -d)
git clone --depth 1 https://github.com/anthropics/skills.git "$TEMP/repo"
cp -r "$TEMP/repo/skills/skill-creator" ~/.claude/skills/skill-creator/
rm -rf "$TEMP"
```

After installation, use the `skill-creator` skill to guide the user through creating their skill.

## Notes

- Skills take effect on the **next conversation turn** — no restart needed
- Skill names: lowercase, hyphens, no spaces (e.g., `my-cool-skill`)
- If a skill with the same name exists, ask before overwriting
- For GitHub operations, prefer `gh` CLI when available, fall back to `git`+`curl`
