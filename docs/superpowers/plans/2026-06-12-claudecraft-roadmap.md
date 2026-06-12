# World of Claudecraft — UX Overhaul, Azure Multi-Region Deploy & Build Automation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the highest-impact mouse/UX problems in the game client, deploy the game to two Azure regions (East US + West US) sharing one Postgres under $150/mo with free Azure DNS, and ship a LangGraph workflow that automatically builds, tests, and self-repairs the project.

**Architecture:** Three independent phases. Phase 1 touches only the browser client (`src/`). Phase 2 adds Azure deploy scripts under `deploy/` plus two small server fixes that make two shards share one database safely. Phase 3 adds a Python LangGraph app under `python/buildflow/` that runs install → typecheck → unit tests → client build → server build, and on any failure asks Claude (official `anthropic` SDK, `claude-opus-4-8`) to diagnose and propose file edits, applies them, and retries (max 3 attempts per step).

**Tech Stack:** TypeScript + Three.js + Vite (client), Node + ws + pg (server), Azure CLI + Docker Compose + Caddy (deploy), Python + LangGraph + anthropic SDK (automation).

---

## Phase 1 — Mouse/UX overhaul (highest-impact fixes)

Issues found during live review: default browser cursor everywhere (no context feedback), pointer lock grabs on plain mousedown (jarring), bags window shows bare "Your bags are empty" text with no slot grid, action-bar/micro-button affordances are weak.

### Task 1.1: Context-sensitive cursors

**Files:**
- Create: `src/ui/cursors.ts`
- Modify: `src/game/input.ts` (expose last mouse position)
- Modify: `src/main.ts` (throttled hover pick in the frame loop)
- Test: `tests/interactions.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `tests/interactions.test.ts`:

```typescript
import { cursorKindForEntity } from '../src/ui/cursors';

describe('cursorKindForEntity', () => {
  it('picks the right cursor per entity kind', () => {
    expect(cursorKindForEntity({ kind: 'npc', dead: false, hostile: false, lootable: false } as any)).toBe('talk');
    expect(cursorKindForEntity({ kind: 'mob', dead: false, hostile: true, lootable: false } as any)).toBe('attack');
    expect(cursorKindForEntity({ kind: 'mob', dead: true, hostile: true, lootable: true } as any)).toBe('loot');
    expect(cursorKindForEntity({ kind: 'mob', dead: true, hostile: true, lootable: false } as any)).toBe(null);
    expect(cursorKindForEntity({ kind: 'object', dead: false, hostile: false, lootable: false } as any)).toBe('interact');
    expect(cursorKindForEntity({ kind: 'player', dead: false, hostile: false, lootable: false } as any)).toBe(null);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/interactions.test.ts`
Expected: FAIL — `Cannot find module '../src/ui/cursors'`

- [ ] **Step 3: Implement `src/ui/cursors.ts`** — pure classifier + canvas-painted cursor data-URLs (matches the repo's "procedural icons, no asset files" convention):

```typescript
// Context-sensitive mouse cursors, painted on canvas at runtime like the
// spell/item icons — no asset files.
import type { Entity } from '../sim/types';

export type CursorKind = 'attack' | 'talk' | 'loot' | 'interact';

export function cursorKindForEntity(e: Pick<Entity, 'kind' | 'dead' | 'hostile' | 'lootable'>): CursorKind | null {
  if (e.kind === 'npc') return 'talk';
  if (e.kind === 'object') return 'interact';
  if (e.kind === 'mob' && e.dead && e.lootable) return 'loot';
  if (e.kind === 'mob' && !e.dead && e.hostile) return 'attack';
  return null;
}

const GLYPH: Record<CursorKind, string> = { attack: '⚔️', talk: '💬', loot: '💰', interact: '✋' };
const cache = new Map<CursorKind, string>();

function cursorCss(kind: CursorKind): string {
  let url = cache.get(kind);
  if (!url) {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d')!;
    ctx.font = '24px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
    ctx.fillText(GLYPH[kind], 16, 17);
    url = c.toDataURL('image/png');
    cache.set(kind, url);
  }
  return `url(${url}) 6 6, auto`;
}

export function applyCursor(canvas: HTMLCanvasElement, kind: CursorKind | null): void {
  canvas.style.cursor = kind ? cursorCss(kind) : 'auto';
}
```

- [ ] **Step 4: Run the test, make sure it passes** — `npx vitest run tests/interactions.test.ts` → PASS (vitest runs in node; the test imports only `cursorKindForEntity`, which touches no DOM).

- [ ] **Step 5: Track the hover position in `src/game/input.ts`** — add two public fields and update them in `onMouseMove` (the existing method at `src/game/input.ts:93`):

```typescript
  // inside class Input
  mouseX = 0;
  mouseY = 0;

  private onMouseMove(e: MouseEvent): void {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    if (!this.leftDown && !this.rightDown) return;
    // ... existing drag/orbit code unchanged
  }
```

- [ ] **Step 6: Wire a throttled hover pick into the frame loop in `src/main.ts`** — find the per-frame update (search `requestAnimationFrame`), add:

```typescript
import { applyCursor, cursorKindForEntity } from './ui/cursors';

let lastHoverPickAt = 0;
function updateHoverCursor(now: number): void {
  if (now - lastHoverPickAt < 120) return; // ~8 picks/sec, raycast is cheap against proxies
  lastHoverPickAt = now;
  if (input.leftDown || input.rightDown) { applyCursor(canvas, null); return; }
  const id = renderer.pick(input.mouseX, input.mouseY); // renderer.pick at src/render/renderer.ts:1040
  const e = id !== null ? world.entities.get(id) : null;
  applyCursor(canvas, e ? cursorKindForEntity(e) : null);
}
// call updateHoverCursor(performance.now()) inside the existing frame callback
```

- [ ] **Step 7: Verify in the browser** — `npm run dev`, enter offline world, hover an NPC (speech bubble), a wolf (sword), a corpse you tapped (coin bag), the well/crates (hand). `node scripts/smoke_browser.mjs` still passes.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(ui): context-sensitive mouse cursors"`

### Task 1.2: Stop grabbing pointer lock on plain clicks

**Files:** Modify: `src/game/input.ts:72-78`

- [ ] **Step 1: Defer pointer lock until an actual drag starts.** Replace `onMouseDown` and extend `onMouseMove`:

```typescript
  private onMouseDown(e: MouseEvent): void {
    if (e.button === 0) this.leftDown = true;
    if (e.button === 2) this.rightDown = true;
    this.downButton = e.button;
    this.dragDistance = 0;
    // pointer lock is requested in onMouseMove once dragDistance > 5 —
    // a plain click (target/interact) never grabs the pointer
  }

  private onMouseMove(e: MouseEvent): void {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    if (!this.leftDown && !this.rightDown) return;
    const mx = e.movementX ?? 0, my = e.movementY ?? 0;
    this.dragDistance += Math.abs(mx) + Math.abs(my);
    if (this.dragDistance > 5 && !document.pointerLockElement) {
      this.canvas.requestPointerLock?.();
    }
    this.camYaw -= mx * 0.0045;
    this.camPitch = Math.min(1.35, Math.max(-0.4, this.camPitch + my * 0.0045));
  }
```

- [ ] **Step 2: Verify** — `npm run dev`: single left-click targets a mob with no pointer-lock flash; right-drag mouselook still locks and feels identical; `node scripts/smoke_browser.mjs` passes.
- [ ] **Step 3: Commit** — `git commit -am "fix(input): defer pointer lock until drag, not mousedown"`

### Task 1.3: Bags window slot grid

**Files:** Modify: `src/ui/hud.ts` (the bag renderer — search for `Your bags are empty`), `index.html` (`.bag-grid` CSS at line ~261)

- [ ] **Step 1: Replace the empty-text bag body with a fixed 16-slot grid.** In the hud bag render function, render 16 slots, filled from inventory:

```typescript
  const SLOTS = 16;
  let html = '<div class="bag-slots">';
  for (let i = 0; i < SLOTS; i++) {
    const slot = inv[i];
    if (slot) {
      const item = ITEMS[slot.itemId];
      html += `<div class="bag-slot" data-i="${i}">${this.itemIcon(item)}${slot.count > 1 ? `<span class="bi-count">${slot.count}</span>` : ''}</div>`;
    } else {
      html += '<div class="bag-slot empty"></div>';
    }
  }
  html += '</div>';
```

- [ ] **Step 2: Add the grid CSS to `index.html`** next to the existing `.bag-grid` rules:

```css
  .bag-slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .bag-slot { position: relative; aspect-ratio: 1; border: 1px solid #4a3d1d; border-radius: 4px;
    background: radial-gradient(circle at 35% 30%, #1b1b26, #0d0d13); display: flex;
    align-items: center; justify-content: center; cursor: pointer; }
  .bag-slot.empty { cursor: default; box-shadow: inset 0 0 8px #000; }
  .bag-slot:not(.empty):hover { border-color: var(--gold); }
  .bag-slot .item-icon { width: 90%; height: 90%; }
  .bag-slot .bi-count { position: absolute; right: 2px; bottom: 1px; font-size: 10px; color: #fff; text-shadow: 1px 1px 1px #000; }
```

- [ ] **Step 3: Re-attach the existing click/tooltip handlers** to `.bag-slot:not(.empty)` (same handlers the old `.bag-item` rows used — use/equip on click, tooltip on hover).
- [ ] **Step 4: Verify** — empty bags show a 4×4 grid of dark slots; buy food from Trader Wilkes → icon + count appears; clicking eats it.
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): WoW-style bag slot grid"`

### Task 1.4: Action bar & micro-button affordances (CSS-only)

**Files:** Modify: `index.html` (`.action-btn` ~line 131, `.micro-btn` ~line 148)

- [ ] **Step 1: Strengthen hover/active feedback:**

```css
  .action-btn:hover { border-color: var(--gold); box-shadow: 0 0 8px #ffd10055, inset 0 1px 0 #ffffff18; }
  .action-btn:hover .icon-label { filter: brightness(1.2); }
  .micro-btn { width: 38px; height: 34px; }
  .micro-btn:hover { box-shadow: 0 0 6px #ffd10044; }
```

- [ ] **Step 2: Verify visually, commit** — `git commit -am "polish(ui): stronger action-bar and micro-button affordances"`

### Phase 1 backlog (separate plans when prioritized)
Click-to-move, draggable/persistent window positions, combat-log resize + filters, world-map player marker, quest-log widening. Each is independent; write its own plan before starting.

---

## Phase 2 — Azure multi-region deployment (East US + West US, ~$100/mo)

**Architecture (from verified research):** two B2s VMs (~$30/mo each) each running the game container behind Caddy, one shared **Azure Database for PostgreSQL Flexible Server** B1ms (~$16/mo) in East US. The two VMs are two *realms/shards* sharing accounts — the in-memory `Sim` never touches Postgres on the hot path (saves are async every 30 s), so the West VM's ~70 ms RTT to the East DB is imperceptible. Free DNS: a **DNS name label** on each VM's Standard public IP gives `{label}.{region}.cloudapp.azure.com`, which Caddy can get Let's Encrypt certs for. Total: ~$100/mo, $50 headroom.

Two code fixes are required before two shards may share one DB.

### Task 2.1: Region-scope `closeOrphanSessions`

**Files:** Modify: `server/db.ts:172-177`, `server/main.ts:198`, plus the `play_sessions` schema block in `ensureSchema` (in `server/db.ts`) and the play-session insert function.

- [ ] **Step 1:** Add to `ensureSchema`'s statements: `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'default';`
- [ ] **Step 2:** Read region once: `const REGION = process.env.REGION ?? 'default';` (top of `server/db.ts`, exported).
- [ ] **Step 3:** Set `region` in the play-session insert (find the `INSERT INTO play_sessions` statement, add the column + `REGION` parameter).
- [ ] **Step 4:** Filter the orphan close:

```typescript
// Sessions left open by a crash have an unknown duration; close them at their
// start time so they don't inflate playtime stats forever. Region-scoped so a
// restart of one shard never closes live sessions on the other.
export async function closeOrphanSessions(): Promise<number> {
  const res = await pool.query(
    'UPDATE play_sessions SET ended_at = started_at WHERE ended_at IS NULL AND region = $1',
    [REGION],
  );
  return res.rowCount ?? 0;
}
```

- [ ] **Step 5:** `npm test` (the suite has `tests/admin.test.ts` coverage of sessions) → PASS. Commit: `git commit -am "fix(server): region-scope orphan session cleanup for multi-shard"`

### Task 2.2: Cross-shard duplicate-login guard

**Files:** Modify: `server/db.ts` (characters schema + two helpers), `server/game.ts:142-145` (join), the leave/disconnect path, and boot in `server/main.ts`.

The in-process check at `server/game.ts:144` only sees local clients; the same character could log into both shards and the 30-second saves would clobber each other (last writer wins).

- [ ] **Step 1:** Schema: `ALTER TABLE characters ADD COLUMN IF NOT EXISTS online_region TEXT;`
- [ ] **Step 2:** Helpers in `server/db.ts`:

```typescript
// Returns true if we claimed the character (it was offline or already ours).
export async function claimCharacterOnline(characterId: number): Promise<boolean> {
  const res = await pool.query(
    `UPDATE characters SET online_region = $2
     WHERE id = $1 AND (online_region IS NULL OR online_region = $2)`,
    [characterId, REGION],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function releaseCharacterOnline(characterId: number): Promise<void> {
  await pool.query(
    'UPDATE characters SET online_region = NULL WHERE id = $1 AND online_region = $2',
    [characterId, REGION],
  );
}

// Boot: clear stale claims from a crash of THIS shard only.
export async function releaseAllCharactersForRegion(): Promise<void> {
  await pool.query('UPDATE characters SET online_region = NULL WHERE online_region = $1', [REGION]);
}
```

- [ ] **Step 3:** In the WS join path (where `game.join(...)` is called in `server/main.ts`), `await claimCharacterOnline(characterId)` first; on `false`, send the existing `'character already in world'` error. Call `releaseCharacterOnline` wherever the session ends (disconnect handler + shutdown save).
- [ ] **Step 4:** Call `releaseAllCharactersForRegion()` right after `closeOrphanSessions()` at `server/main.ts:198`.
- [ ] **Step 5:** `npm test` → PASS; `node scripts/mp_integration.mjs` (with `npm run db:up` + server running) → 26/26. Commit: `git commit -am "feat(server): cross-shard duplicate-login guard via online_region"`

### Task 2.3: `deploy/docker-compose.azure.yml` — game-only override

- [ ] **Step 1: Create** (compose merges this over the base file; the managed DB replaces the local postgres service):

```yaml
# Azure mode: managed Postgres Flexible Server, no local postgres container.
# Usage: docker compose -f docker-compose.yml -f deploy/docker-compose.azure.yml up -d --build game
services:
  game:
    depends_on: !reset []
    environment:
      DATABASE_URL: ${DATABASE_URL:?Set DATABASE_URL in .env (Azure Postgres connection string)}
      REGION: ${REGION:?Set REGION in .env (eastus or westus)}
      PORT: "8787"
```

- [ ] **Step 2: Commit** — `git commit -am "deploy: compose override for Azure managed Postgres"`

### Task 2.4: `deploy/user-data-azure.sh` — VM first-boot script

- [ ] **Step 1: Create** — derived from `deploy/user-data.sh` (swap, Docker, Caddy, clone, backups all carry over). The deploy script (Task 2.5) substitutes `__DOMAIN__`, `__DATABASE_URL__`, `__REGION__`, `__REPO__` before passing it as custom-data:

```bash
#!/bin/bash
# World of Claudecraft — Azure VM first-boot setup (cloud-init custom data).
# Placeholders are substituted by deploy/azure-deploy.sh.
DOMAIN="__DOMAIN__"
DATABASE_URL="__DATABASE_URL__"
REGION="__REGION__"
REPO="__REPO__"
APP_DIR="/opt/eastbrook"

set -euo pipefail
exec > >(tee -a /var/log/eastbrook-setup.log) 2>&1
echo "=== World of Claudecraft Azure setup started: $(date -u) ==="

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 git curl gnupg apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
systemctl enable --now docker

[ -d "$APP_DIR" ] || git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"
{
  echo "DATABASE_URL=$DATABASE_URL"
  echo "REGION=$REGION"
  echo "POSTGRES_PASSWORD=unused-managed-db"
} > .env
chmod 600 .env

docker compose -f docker-compose.yml -f deploy/docker-compose.azure.yml up -d --build game

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy localhost:8787
	encode gzip
}
CADDY
systemctl enable caddy && systemctl restart caddy

echo "=== setup finished: $(date -u) ==="
curl -s --max-time 5 http://localhost:8787/api/status || echo 'game not up yet — docker compose logs game'
```

(No pg_dump cron — Flexible Server includes 7-day automated backups.)

- [ ] **Step 2: Commit** — `git commit -am "deploy: Azure first-boot user-data script"`

### Task 2.5: `deploy/azure-deploy.sh` — one-command provisioning

- [ ] **Step 1: Create:**

```bash
#!/bin/bash
# Provision World of Claudecraft on Azure: 1 shared Postgres + 2 regional game VMs.
# Prereqs: az CLI logged in (az login). Idempotent-ish: rerun after fixing errors.
set -euo pipefail

RG="claudecraft-rg"
PG_NAME="${PG_NAME:-claudecraft-pg-$RANDOM}"     # globally unique
REPO="${REPO:-https://github.com/apramodk/world-of-claudecraft.git}"
REGIONS=(eastus westus)
PG_PASS="$(openssl rand -hex 24)"

az group create -n "$RG" -l eastus

echo "--- shared Postgres Flexible Server (B1ms, ~\$16/mo) ---"
az postgres flexible-server create -g "$RG" -n "$PG_NAME" -l eastus \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 \
  --version 16 --admin-user eastbrook --admin-password "$PG_PASS" \
  --public-access None
az postgres flexible-server db create -g "$RG" -s "$PG_NAME" -d eastbrook
DB_HOST="$PG_NAME.postgres.database.azure.com"
DATABASE_URL="postgres://eastbrook:$PG_PASS@$DB_HOST:5432/eastbrook?sslmode=require"

for REGION in "${REGIONS[@]}"; do
  VM="claudecraft-${REGION%us}"                  # claudecraft-east / claudecraft-west
  FQDN="$VM.$REGION.cloudapp.azure.com"
  echo "--- VM $VM in $REGION → https://$FQDN ---"

  sed -e "s|__DOMAIN__|$FQDN|" \
      -e "s|__DATABASE_URL__|$DATABASE_URL|" \
      -e "s|__REGION__|$REGION|" \
      -e "s|__REPO__|$REPO|" \
      deploy/user-data-azure.sh > "/tmp/user-data-$VM.sh"

  az vm create -g "$RG" -n "$VM" -l "$REGION" \
    --size Standard_B2s \
    --image Canonical:ubuntu-24_04-lts:server:latest \
    --admin-username azureuser --generate-ssh-keys \
    --public-ip-sku Standard \
    --public-ip-address-dns-name "$VM" \
    --os-disk-size-gb 30 \
    --custom-data "/tmp/user-data-$VM.sh"
  az vm open-port -g "$RG" -n "$VM" --port 80,443 --priority 1001

  IP=$(az vm show -d -g "$RG" -n "$VM" --query publicIps -o tsv)
  az postgres flexible-server firewall-rule create -g "$RG" -n "$PG_NAME" \
    --rule-name "allow-$VM" --start-ip-address "$IP" --end-ip-address "$IP"
  rm -f "/tmp/user-data-$VM.sh"
done

echo ""
echo "Done. Realms (TLS auto via Caddy/Let's Encrypt, first boot takes a few minutes):"
echo "  East: https://claudecraft-east.eastus.cloudapp.azure.com"
echo "  West: https://claudecraft-west.westus.cloudapp.azure.com"
echo "Watch a boot: ssh azureuser@<fqdn> sudo tail -f /var/log/eastbrook-setup.log"
```

> Note: `--public-access None` + per-VM firewall rules — the `az postgres flexible-server firewall-rule create` calls switch the server to public-access-with-firewall; only the two VM IPs are allowed. TLS is enforced (`sslmode=require`).

- [ ] **Step 2:** `bash -n deploy/azure-deploy.sh && bash -n deploy/user-data-azure.sh` (syntax check) → clean.
- [ ] **Step 3: Commit** — `git commit -am "deploy: Azure multi-region provisioning script"`

### Task 2.6: Realm picker (client)

**Files:** Modify: `index.html` (start screen), `src/net/` login flow.

- [ ] **Step 1:** Add a realm row above the login panel: two buttons (`Eastbrook East`, `Eastbrook West`) mapped to the two FQDNs; persist choice in `localStorage('realm')`; default by racing `fetch('https://<fqdn>/api/status')` latency. All REST + WS calls use the chosen origin instead of same-origin when a realm is selected.
- [ ] **Step 2:** Requires CORS allowance on the game server for the two known origins (check `server/main.ts` headers; add `Access-Control-Allow-Origin` for the sibling realm origins).
- [ ] **Step 3:** Verify with both realms live; commit.

**Cost summary:** 2× B2s $60.74 + 2× Standard IP $7.30 + disks ~$7 + PG B1ms ~$16 + egress ~$8 ≈ **$99/mo** (budget $150).

---

## Phase 3 — LangGraph build/test automation (`python/buildflow/`)

A LangGraph `StateGraph` that runs the project's build+test pipeline as nodes with deterministic edges; on failure it routes to a Claude-powered diagnose node (official `anthropic` SDK, model `claude-opus-4-8`, adaptive thinking), applies the proposed file edits, and retries the failed step (max 3 attempts per step), then writes `buildflow-report.md`.

```
install → typecheck → unit_tests → build_client → build_server → report
   ↘ fail      ↘ fail       ↘ fail        ↘ fail         ↘ fail
              diagnose → apply_fix → (retry failed step | report if attempts ≥ 3)
```

### Task 3.1: State + pipeline definition (`python/buildflow/state.py`)

- [ ] **Step 1: Create:**

```python
"""Shared state for the buildflow graph."""
from typing import TypedDict, Optional

# Ordered pipeline: (step name, shell command). Commands run from the repo root.
PIPELINE: list[tuple[str, str]] = [
    ("install", "npm install"),
    ("typecheck", "npx tsc --noEmit"),
    ("unit_tests", "npx vitest run"),
    ("build_client", "npm run build"),
    ("build_server", "npm run build:server"),
]
MAX_FIX_ATTEMPTS = 3


class BuildState(TypedDict):
    step_index: int                 # which PIPELINE entry runs next
    failed_step: Optional[str]      # name of the step that just failed
    failure_output: str             # captured stdout+stderr of the failure
    fix_attempts: dict[str, int]    # per-step retry counter
    history: list[str]              # human-readable log lines
    proposed_edits: list[dict]      # [{"path": ..., "old": ..., "new": ...}]
```

### Task 3.2: Step runner (`python/buildflow/steps.py`)

- [ ] **Step 1: Create:**

```python
"""Run pipeline commands and capture results."""
import subprocess
from .state import PIPELINE, BuildState

REPO_ROOT = None  # set by __main__


def run_step(state: BuildState) -> BuildState:
    name, cmd = PIPELINE[state["step_index"]]
    print(f"[buildflow] running {name}: {cmd}")
    proc = subprocess.run(
        cmd, shell=True, cwd=REPO_ROOT, capture_output=True, text=True, timeout=900,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0:
        state["history"].append(f"PASS {name}")
        state["step_index"] += 1
        state["failed_step"] = None
        state["failure_output"] = ""
    else:
        state["history"].append(f"FAIL {name} (exit {proc.returncode})")
        state["failed_step"] = name
        state["failure_output"] = out[-12000:]  # keep the tail — errors are at the end
    return state


def route_after_step(state: BuildState) -> str:
    """Conditional edge: continue, diagnose, or finish."""
    if state["failed_step"] is not None:
        from .state import MAX_FIX_ATTEMPTS
        attempts = state["fix_attempts"].get(state["failed_step"], 0)
        return "diagnose" if attempts < MAX_FIX_ATTEMPTS else "report"
    if state["step_index"] >= len(PIPELINE):
        return "report"
    return "run_step"
```

### Task 3.3: Routing unit tests (`python/buildflow/test_routing.py`) — no API calls

- [ ] **Step 1: Write the tests:**

```python
from buildflow.state import BuildState, PIPELINE
from buildflow.steps import route_after_step


def make_state(**kw) -> BuildState:
    base: BuildState = {
        "step_index": 0, "failed_step": None, "failure_output": "",
        "fix_attempts": {}, "history": [], "proposed_edits": [],
    }
    base.update(kw)  # type: ignore[typeddict-item]
    return base


def test_success_routes_to_next_step():
    assert route_after_step(make_state(step_index=1)) == "run_step"


def test_all_steps_done_routes_to_report():
    assert route_after_step(make_state(step_index=len(PIPELINE))) == "report"


def test_failure_routes_to_diagnose():
    assert route_after_step(make_state(failed_step="unit_tests")) == "diagnose"


def test_failure_after_max_attempts_routes_to_report():
    s = make_state(failed_step="unit_tests", fix_attempts={"unit_tests": 3})
    assert route_after_step(s) == "report"
```

- [ ] **Step 2:** `python -m pytest python/buildflow/test_routing.py -v` → 4 passed (after Task 3.2 exists; run order in execution is fine since both land together).

### Task 3.4: Claude diagnose + fix (`python/buildflow/fixer.py`)

- [ ] **Step 1: Create** — official `anthropic` SDK, `claude-opus-4-8`, adaptive thinking, structured JSON output:

```python
"""Diagnose a failed build step with Claude and apply proposed edits."""
import json
import pathlib
from anthropic import Anthropic
from .state import BuildState

client = Anthropic()  # reads ANTHROPIC_API_KEY
REPO_ROOT: pathlib.Path = None  # set by __main__

EDIT_SCHEMA = {
    "type": "object",
    "properties": {
        "diagnosis": {"type": "string"},
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "repo-relative file path"},
                    "old": {"type": "string", "description": "exact text to replace"},
                    "new": {"type": "string", "description": "replacement text"},
                },
                "required": ["path", "old", "new"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["diagnosis", "edits"],
    "additionalProperties": False,
}


def diagnose(state: BuildState) -> BuildState:
    step = state["failed_step"]
    state["fix_attempts"][step] = state["fix_attempts"].get(step, 0) + 1
    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": EDIT_SCHEMA}},
        system=(
            "You are a build doctor for a TypeScript game project (Vite client, "
            "esbuild-bundled Node server, vitest tests). Given a failed build step's "
            "output, propose minimal exact-string file edits to fix it. If the failure "
            "is environmental (missing tool, network), return an empty edits list and "
            "say so in the diagnosis."
        ),
        messages=[{
            "role": "user",
            "content": f"Step `{step}` failed. Output (tail):\n\n{state['failure_output']}",
        }],
    )
    if response.stop_reason == "refusal":
        state["history"].append(f"diagnose {step}: refused")
        state["proposed_edits"] = []
        return state
    payload = json.loads(response.content[-1].text)
    state["history"].append(f"diagnose {step} (attempt {state['fix_attempts'][step]}): {payload['diagnosis'][:200]}")
    state["proposed_edits"] = payload["edits"]
    return state


def apply_fix(state: BuildState) -> BuildState:
    applied = 0
    for edit in state["proposed_edits"]:
        target = (REPO_ROOT / edit["path"]).resolve()
        if REPO_ROOT.resolve() not in target.parents and target != REPO_ROOT.resolve():
            state["history"].append(f"SKIP edit outside repo: {edit['path']}")
            continue
        try:
            text = target.read_text(encoding="utf-8")
        except FileNotFoundError:
            state["history"].append(f"SKIP missing file: {edit['path']}")
            continue
        if edit["old"] not in text:
            state["history"].append(f"SKIP no match in {edit['path']}")
            continue
        target.write_text(text.replace(edit["old"], edit["new"], 1), encoding="utf-8")
        applied += 1
        state["history"].append(f"EDIT {edit['path']}")
    state["history"].append(f"applied {applied}/{len(state['proposed_edits'])} edits, retrying {state['failed_step']}")
    state["proposed_edits"] = []
    # leave step_index pointing at the failed step so run_step retries it
    state["failed_step"] = None
    state["failure_output"] = ""
    return state
```

### Task 3.5: Graph wiring + CLI (`python/buildflow/graph.py`, `python/buildflow/__main__.py`, `python/buildflow/requirements.txt`)

- [ ] **Step 1: `graph.py`:**

```python
"""LangGraph wiring: pipeline with diagnose/fix loop."""
from langgraph.graph import StateGraph, START, END
from .state import BuildState
from .steps import run_step, route_after_step
from .fixer import diagnose, apply_fix


def write_report(state: BuildState) -> BuildState:
    from .steps import REPO_ROOT
    from .state import PIPELINE
    done = state["step_index"] >= len(PIPELINE) and state["failed_step"] is None
    lines = ["# buildflow report", "", f"**Result: {'SUCCESS' if done else 'FAILED'}**", ""]
    lines += [f"- {h}" for h in state["history"]]
    (REPO_ROOT / "buildflow-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return state


def build_graph():
    g = StateGraph(BuildState)
    g.add_node("run_step", run_step)
    g.add_node("diagnose", diagnose)
    g.add_node("apply_fix", apply_fix)
    g.add_node("report", write_report)
    g.add_edge(START, "run_step")
    g.add_conditional_edges("run_step", route_after_step,
                            {"run_step": "run_step", "diagnose": "diagnose", "report": "report"})
    g.add_edge("diagnose", "apply_fix")
    g.add_edge("apply_fix", "run_step")
    g.add_edge("report", END)
    return g.compile()
```

- [ ] **Step 2: `__main__.py`:**

```python
"""Run: python -m buildflow [repo_root]   (from the python/ directory)"""
import pathlib
import sys
from . import steps, fixer
from .graph import build_graph
from .state import BuildState

repo_root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[2]
steps.REPO_ROOT = repo_root
fixer.REPO_ROOT = repo_root

initial: BuildState = {
    "step_index": 0, "failed_step": None, "failure_output": "",
    "fix_attempts": {}, "history": [], "proposed_edits": [],
}
build_graph().invoke(initial, config={"recursion_limit": 100})
```

- [ ] **Step 3: `requirements.txt`:**

```
langgraph>=0.2
anthropic>=0.40
pytest>=8
```

- [ ] **Step 4:** `pip install -r python/buildflow/requirements.txt`, then `python -m pytest python/buildflow/test_routing.py -v` → 4 passed.
- [ ] **Step 5:** Dry run without API key — `python -m buildflow` from `python/`: pipeline runs; on green repo it reaches `report` with all PASS lines and never calls Claude.
- [ ] **Step 6: Commit** — `git add python/buildflow && git commit -m "feat: LangGraph build/test automation with Claude self-repair"`

---

## Self-review notes
- Spec coverage: UI/UX (Phase 1 + explicit backlog), multi-region Azure with free DNS (Phase 2), LangGraph build+test automation (Phase 3) — all covered.
- The `!reset` directive in Task 2.3 requires Compose v2.24+; Ubuntu 24.04's `docker-compose-v2` ships ≥2.24. If an older compose lands, replace the override with a standalone compose file.
- Phase 1 Tasks 1.1/1.2 reference verified symbols (`renderer.pick` at renderer.ts:1040, `Input.onMouseMove` at input.ts:93). Tasks 1.3 and 2.1–2.2 include locate-by-search steps where exact line anchors weren't pre-verified; the replacement code is complete.
- Diagnose node guards: path-traversal check on edits, refusal handling, empty-edit environmental failures still count against `MAX_FIX_ATTEMPTS` so the loop always terminates (recursion_limit 100 is the hard backstop).
