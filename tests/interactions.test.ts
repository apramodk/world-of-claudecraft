import { describe, expect, it, vi } from 'vitest';
import { handlePickedEntity } from '../src/game/interactions';
import { cursorKindForEntity } from '../src/ui/cursors';
import type { Entity } from '../src/sim/types';

function player(): Entity {
  return {
    id: 1,
    kind: 'player',
    templateId: '',
    name: 'Tester',
    level: 1,
    pos: { x: 0, y: 0, z: 0 },
    prevPos: { x: 0, y: 0, z: 0 },
    facing: 0,
    prevFacing: 0,
    hp: 100,
    maxHp: 100,
    resource: 0,
    maxResource: 0,
    resourceType: null,
    xp: 0,
    dead: false,
    targetId: null,
    autoAttack: false,
    swingTimer: 0,
    cast: null,
    gcd: 0,
    cooldowns: {},
    auras: [],
    combo: 0,
    comboTargetId: null,
    sitting: false,
    scale: 1,
  } as unknown as Entity;
}

function lootableMob(): Entity {
  return {
    id: 2,
    kind: 'mob',
    templateId: 'forest_wolf',
    name: 'Forest Wolf',
    level: 1,
    pos: { x: 2, y: 0, z: 0 },
    prevPos: { x: 2, y: 0, z: 0 },
    facing: 0,
    prevFacing: 0,
    hp: 0,
    maxHp: 20,
    resource: 0,
    maxResource: 0,
    resourceType: null,
    xp: 0,
    dead: true,
    targetId: null,
    autoAttack: false,
    swingTimer: 0,
    cast: null,
    gcd: 0,
    cooldowns: {},
    auras: [],
    combo: 0,
    comboTargetId: null,
    sitting: false,
    scale: 1,
    hostile: true,
    aiState: 'dead',
    aggroTargetId: null,
    spawnPos: { x: 2, y: 0, z: 0 },
    respawnTimer: 0,
    corpseTimer: 0,
    lootable: true,
    loot: { copper: 3, items: [] },
  } as unknown as Entity;
}

describe('picked entity interactions', () => {
  it('opens loot when left-clicking a lootable mob in range', () => {
    const p = player();
    const mob = lootableMob();
    const world = {
      player: p,
      entities: new Map([[p.id, p], [mob.id, mob]]),
      targetEntity: vi.fn(),
      enterDungeon: vi.fn(),
      leaveDungeon: vi.fn(),
      pickUpObject: vi.fn(),
      startAutoAttack: vi.fn(),
    };
    const hud = {
      openLoot: vi.fn(),
      openQuestDialog: vi.fn(),
      showError: vi.fn(),
      closeContextMenu: vi.fn(),
    };

    handlePickedEntity(world, hud, mob.id, 0, 120, 160);

    expect(world.targetEntity).toHaveBeenCalledWith(mob.id);
    expect(hud.openLoot).toHaveBeenCalledWith(mob.id, 120, 160);
    expect(hud.showError).not.toHaveBeenCalled();
  });
});

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
