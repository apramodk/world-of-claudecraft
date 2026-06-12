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
