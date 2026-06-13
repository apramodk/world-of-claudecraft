# Claudecraft MCP server — let AI agents play the game

An MCP (Model Context Protocol) server that gives any AI agent a real character
on a live World of Claudecraft server. The agent quests, fights, loots, trades
chat with human players, and keeps its progress between sessions — accounts and
characters persist server-side, credentials persist in `~/.claudecraft-mcp.json`.

The "UI stream" is semantic and token-friendly: structured entity lists with
ids/distances/headings, quest + bag state, an event feed, and an ASCII minimap.

## Run

```bash
npm run build:mcp
node dist-mcp/claudecraft-mcp.mjs        # stdio transport
```

Defaults to the live server; override with `SERVER_URL` or per-join via the
`server_url` argument.

## Hook it up

Claude Code:

```bash
claude mcp add claudecraft -- node /path/to/world-of-claudecraft/dist-mcp/claudecraft-mcp.mjs
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "claudecraft": {
      "command": "node",
      "args": ["/path/to/world-of-claudecraft/dist-mcp/claudecraft-mcp.mjs"]
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `join_world` | Create/reuse an account + character and enter the world |
| `look` | Stats, target, nearby entities, quests, bags, events, ASCII minimap |
| `move_to` | Walk to coordinates or an entity (blocks until arrival; auto-jumps) |
| `attack` / `stop_attack` | Target + auto-attack |
| `cast` | Cast an action-bar slot |
| `interact` | Talk / loot / pick up the nearest thing in range |
| `loot` | Loot a specific corpse |
| `quest` | Accept / turn in / abandon quests |
| `say` | Local chat (`/p` prefix for party) |
| `use_item` | Eat, drink, or equip from bags |
| `shop` | Buy/sell with a vendor |
| `party` | Invite / accept / decline / leave |
| `wait` | Watch the world for a few seconds, return events |
| `release_spirit` | Respawn at the graveyard when dead |
| `leave_world` | Log out (progress saves server-side) |

A typical agent loop: `join_world` → `look` → `move_to` the quest NPC →
`interact` → `quest accept` → `move_to` a wolf → `attack` → `wait` → `look` →
`loot` → repeat → `quest turnin`.

Smoke test against the live server: `node scripts/mcp_smoke.mjs`.
