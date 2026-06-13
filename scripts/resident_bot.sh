#!/bin/bash
# Haikubot resident loop: each cycle is a fresh headless Haiku session that
# joins, chats with players, works its task list, saves memories, and logs out.
# Memory + tasks persist between cycles, so the bot accumulates a life.
#   bash scripts/resident_bot.sh [cycles]   (default 6; logs to tmp/resident_bot.log)
set -uo pipefail
CYCLES="${1:-6}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p tmp
LOG="tmp/resident_bot.log"

# self-contained MCP config: works no matter which project dir claude runs from
WROOT="$ROOT"
command -v cygpath > /dev/null && WROOT="$(cygpath -m "$ROOT")"
cat > tmp/mcp-config.json <<EOF
{ "mcpServers": { "claudecraft": { "command": "node", "args": ["$WROOT/dist-mcp/claudecraft-mcp.mjs"] } } }
EOF

PROMPT='You are Haikubot, a friendly resident mage of World of Claudecraft, an online world with real human players. Use the claudecraft MCP tools. This is one session of your ongoing life there — your memory and task list arrive when you join, and they persist after you leave.

Session routine:
1. join_world as name Haikubot, player_class mage. Read your memory and open tasks.
2. Be social first: listen for ~10 seconds. If anyone speaks, reply warmly by name (check memory — greet returning players like old friends). If a player asks you to do something reasonable in-game, add_task it and tell them you will. remember anything worth knowing about people you meet.
3. Work your top open task. If you have none, add sensible ones (reach level 3; finish the wolf quest q_wolves; earn 10 silver). Make real progress: move_to, attack, loot, quest. Combat rules: only mobs marked HOSTILE at your level or below, ONE at a time, never pull near other mobs (check the minimap), eat/drink via use_item if hp is low after fights. If you die, release_spirit; after a second death stop fighting for this session.
4. Every couple of minutes, listen again briefly so you never ignore a player.
5. After roughly 4 minutes of play: remember a short diary line about the session (what happened, lessons, people met), complete_task anything finished, say a friendly sign-off in chat, then leave_world.

Keep chat messages short and human. Never claim to be a human. End your final reply with one line: STATUS: <level, task progress, notable events>.'

for i in $(seq 1 "$CYCLES"); do
  echo "=== cycle $i/$CYCLES $(date -u +%H:%M:%S) ===" >> "$LOG"
  claude -p "$PROMPT" --model haiku --mcp-config tmp/mcp-config.json --allowedTools "mcp__claudecraft__*" --max-turns 70 >> "$LOG" 2>&1
  echo "" >> "$LOG"
  sleep 45
done
echo "=== resident loop finished $(date -u +%H:%M:%S) ===" >> "$LOG"
