---
name: install
description: Install an external skill into Nonnaclaw. Clones the skill's git repo into ../nonnaclaw-skills/, installs dependencies, reads the skill's own SKILL.md for auth/setup instructions, and restarts the service. Use when user says "install skill", "add skill", or provides a skill repo URL.
---

# Install External Skill

Generic installer for Nonnaclaw skills. Skills are self-contained packages in their own git repos, installed into the sibling `nonnaclaw-skills/` directory. This skill clones, builds, configures, and activates them. **No code changes to core are ever needed.**

## Workflow

### 1. Identify the skill

The user provides either:
- A git repo URL (e.g., `https://github.com/user/nonnaclaw-whatsapp`)
- A shorthand name (e.g., `whatsapp`) — search for `nonnaclaw-{name}` repos

If only a name is given, ask the user for the repo URL.

### 2. Clone into nonnaclaw-skills/

```bash
mkdir -p ../nonnaclaw-skills
cd ../nonnaclaw-skills
git clone <repo-url> <skill-name>
```

If `../nonnaclaw-skills/<skill-name>` already exists, ask the user: update existing or reinstall?
- Update: `cd ../nonnaclaw-skills/<skill-name> && git pull`
- Reinstall: remove and re-clone

### 3. Validate skill.json

Read `../nonnaclaw-skills/<skill-name>/skill.json`. It must have:
- `name` (string, required)
- `version` (string, required)

It should also declare one or more of:
- `mcp` — an MCP server to run on the host (the primary pattern)
- `scopeTemplate` — tool authorization rules for per-group scoping
- `inbound` — legacy poll-based inbound entrypoint
- `mcpServers` — legacy per-container MCP servers

If `skill.json` is missing or invalid, stop and tell the user this doesn't look like a valid Nonnaclaw skill.

### 4. Install dependencies

If `package.json` exists in the skill directory:
```bash
cd ../nonnaclaw-skills/<skill-name>
npm install
```

If there's a `build` script in package.json:
```bash
npm run build
```

### 5. Read and follow SKILL.md

**This is the critical handoff step.** Read `../nonnaclaw-skills/<skill-name>/SKILL.md` if it exists. This file contains the skill author's setup instructions — auth flows, env vars, configuration steps.

Follow the instructions in SKILL.md. Common patterns:
- **Env vars**: Add required env vars to the project's `.env` file
- **Auth flows**: Run auth scripts (e.g., QR code scanning for WhatsApp)
- **Group authorization**: Register which groups can use the skill's tools

If there's no SKILL.md, proceed with defaults based on skill.json.

### 6. Configure env vars

If `skill.json` declares `mcp.envKeys` or `envKeys`:
1. Check if these keys already exist in the project's `.env` file
2. For missing keys, ask the user for the values
3. Add them to `.env`

### 7. Authorize groups (if scopeTemplate exists)

If the skill has a `scopeTemplate`, ask the user which groups should have access:

```
AskUserQuestion: Which groups should have access to the {skill-name} skill?
- All groups
- Main group only
- Specific groups: [list registered groups]
```

For each authorized group, update its registration to include `authorizedSkills`:
```json
{
  "authorizedSkills": {
    "<skill-name>": {
      "pinnedParams": {
        "send_message.chat_id": "<group-jid>"
      }
    }
  }
}
```

The `pinnedParams` are derived from the `scopeTemplate`'s `scopedParams`. For each tool with `scopedParams`, ask the user what value to pin for each group.

For common patterns:
- If a `scopedParam` is named `chat_id`, `jid`, or `channel_id`, suggest using the group's own JID
- If a `scopedParam` is named `repo`, `project`, or `workspace`, ask the user explicitly

### 8. Restart the service

```bash
npm run build
```

Then restart the service:
- macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- Linux: `systemctl --user restart nanoclaw`

### 9. Verify

After restart, check the logs to confirm the skill loaded:
```bash
tail -20 logs/nanoclaw.log | grep -i "skill loaded"
```

If the skill has an `mcp` field, also check the MCP bridge started:
```bash
tail -20 logs/nanoclaw.log | grep -i "MCP bridge"
```

Tell the user the skill is installed and ready. Remind them how to test it.

## Uninstalling a skill

If the user asks to uninstall/remove a skill:
1. Remove the group authorizations (update `authorizedSkills` in the DB)
2. Delete `../nonnaclaw-skills/<skill-name>/`
3. Restart the service

## Key principles

- **Never modify core files.** If installing a skill requires changes to `src/`, `container/`, or `package.json`, something is wrong with the skill or the architecture.
- **Skills live outside core.** All skills go in `../nonnaclaw-skills/`, never inside the nonnaclaw repo.
- **Skills own their dependencies.** The skill's `package.json` is separate from Nonnaclaw's.
- **Env vars go in the project .env.** The host resolves them at runtime via `envKeys` declarations.
- **Trust the skill's SKILL.md.** The skill author knows their setup requirements. Follow their instructions.
- **Per-group scoping is mandatory.** If a skill has `scopeTemplate` with `scopedParams`, every group must have explicit pinned values. Don't skip this step.
