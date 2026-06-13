import { Pool } from 'pg';
import type { CharacterState } from '../src/sim/sim';
import type { PlayerClass } from '../src/sim/types';

try {
  process.loadEnvFile?.();
} catch {
  // .env is optional; production usually injects DATABASE_URL directly.
}

export const DATABASE_URL =
  process.env.DATABASE_URL ?? (() => {
    throw new Error('DATABASE_URL is required. For local dev, copy .env.example to .env and run through docker compose.');
  })();

export const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

// Shard identity: multiple regional servers may share one database. Region
// scoping keeps one shard's restarts and login claims from touching another's.
export const REGION = process.env.REGION ?? 'default';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_tokens_account ON auth_tokens(account_id);
CREATE TABLE IF NOT EXISTS characters (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT UNIQUE NOT NULL,
  class TEXT NOT NULL,
  level INT NOT NULL DEFAULT 1,
  state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS characters_account ON characters(account_id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS is_gm BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS online_region TEXT;
CREATE TABLE IF NOT EXISTS play_sessions (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  character_id INT REFERENCES characters(id) ON DELETE SET NULL,
  character_name TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS play_sessions_account ON play_sessions(account_id);
CREATE INDEX IF NOT EXISTS play_sessions_started ON play_sessions(started_at);
ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'default';
`;

export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA);
}

export interface AccountRow {
  id: number;
  username: string;
  password_hash: string;
}

export async function createAccount(username: string, passwordHash: string): Promise<AccountRow> {
  const res = await pool.query(
    'INSERT INTO accounts (username, password_hash) VALUES ($1, $2) RETURNING id, username, password_hash',
    [username, passwordHash],
  );
  return res.rows[0];
}

export async function findAccount(username: string): Promise<AccountRow | null> {
  const res = await pool.query('SELECT id, username, password_hash FROM accounts WHERE username = $1', [username]);
  return res.rows[0] ?? null;
}

export async function touchLogin(accountId: number): Promise<void> {
  await pool.query('UPDATE accounts SET last_login = now() WHERE id = $1', [accountId]);
}

export async function saveToken(token: string, accountId: number, ttlHours = 24 * 7): Promise<void> {
  await pool.query(
    `INSERT INTO auth_tokens (token, account_id, expires_at) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [token, accountId, String(ttlHours)],
  );
}

export async function accountForToken(token: string): Promise<number | null> {
  const res = await pool.query(
    'SELECT account_id FROM auth_tokens WHERE token = $1 AND expires_at > now()',
    [token],
  );
  return res.rows[0]?.account_id ?? null;
}

export interface CharacterRow {
  id: number;
  account_id: number;
  name: string;
  class: PlayerClass;
  level: number;
  state: CharacterState | null;
  is_gm: boolean;
}

export async function listCharacters(accountId: number): Promise<CharacterRow[]> {
  const res = await pool.query(
    'SELECT id, account_id, name, class, level, state, is_gm FROM characters WHERE account_id = $1 ORDER BY id',
    [accountId],
  );
  return res.rows;
}

export async function getCharacter(accountId: number, characterId: number): Promise<CharacterRow | null> {
  const res = await pool.query(
    'SELECT id, account_id, name, class, level, state, is_gm FROM characters WHERE id = $1 AND account_id = $2',
    [characterId, accountId],
  );
  return res.rows[0] ?? null;
}

export async function createCharacter(accountId: number, name: string, cls: PlayerClass): Promise<CharacterRow> {
  const res = await pool.query(
    'INSERT INTO characters (account_id, name, class) VALUES ($1, $2, $3) RETURNING id, account_id, name, class, level, state, is_gm',
    [accountId, name, cls],
  );
  return res.rows[0];
}

export async function deleteCharacter(accountId: number, characterId: number): Promise<boolean> {
  const res = await pool.query('DELETE FROM characters WHERE id = $1 AND account_id = $2', [characterId, accountId]);
  return (res.rowCount ?? 0) > 0;
}

export async function saveCharacterState(characterId: number, level: number, state: CharacterState): Promise<void> {
  await pool.query(
    'UPDATE characters SET level = $2, state = $3, updated_at = now() WHERE id = $1',
    [characterId, level, JSON.stringify(state)],
  );
}

export async function isAdminAccount(accountId: number): Promise<boolean> {
  const res = await pool.query('SELECT is_admin FROM accounts WHERE id = $1', [accountId]);
  return res.rows[0]?.is_admin === true;
}

// ---------------------------------------------------------------------------
// Play sessions: one row per character login, closed on logout. Powers the
// admin dashboard's playtime / DAU / sessions-per-day metrics.
// ---------------------------------------------------------------------------

export async function openPlaySession(
  accountId: number,
  characterId: number,
  characterName: string,
): Promise<number> {
  const res = await pool.query(
    'INSERT INTO play_sessions (account_id, character_id, character_name, region) VALUES ($1, $2, $3, $4) RETURNING id',
    [accountId, characterId, characterName, REGION],
  );
  return res.rows[0].id;
}

export async function closePlaySession(sessionId: number): Promise<void> {
  await pool.query('UPDATE play_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [sessionId]);
}

// Sessions left open by a crash have an unknown duration; close them at their
// start time so they don't inflate playtime stats forever. Region-scoped so a
// restart of one shard never closes live sessions on another.
export async function closeOrphanSessions(): Promise<number> {
  const res = await pool.query(
    'UPDATE play_sessions SET ended_at = started_at WHERE ended_at IS NULL AND region = $1',
    [REGION],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Cross-shard duplicate-login guard: the in-process check in game.ts only sees
// this shard's clients; online_region makes the claim global.

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
