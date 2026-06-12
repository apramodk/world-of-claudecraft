import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatLogger, parseChat, type ChatLogRow } from '../server/chat_log';

function row(message: string, channel = 'say'): ChatLogRow {
  return { accountId: 1, characterId: 2, characterName: 'Zyx', channel, message };
}

describe('parseChat', () => {
  it('routes plain text to say', () => {
    expect(parseChat('hello world')).toEqual({ channel: 'say', message: 'hello world' });
  });

  it('routes /p and /party to the party channel without the prefix', () => {
    expect(parseChat('/p inc on the left')).toEqual({ channel: 'party', message: 'inc on the left' });
    expect(parseChat('/party pull the boss')).toEqual({ channel: 'party', message: 'pull the boss' });
  });

  it('discards what the sim would discard', () => {
    expect(parseChat('')).toBeNull();
    expect(parseChat('   ')).toBeNull();
  });

  it("treats a bare '/p' like the sim does: say, not party", () => {
    // '/p   ' trims to '/p', which Sim.chat does not recognize as a prefix
    expect(parseChat('/p   ')).toEqual({ channel: 'say', message: '/p' });
  });

  it('caps messages at 200 characters like Sim.chat', () => {
    const parsed = parseChat('x'.repeat(500));
    expect(parsed?.message.length).toBe(200);
  });
});

describe('ChatLogger', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches rows and flushes on the timer', async () => {
    const writes: ChatLogRow[][] = [];
    const logger = new ChatLogger(async (rows) => { writes.push(rows); });
    logger.log(row('one'));
    logger.log(row('two'));
    expect(writes).toHaveLength(0); // nothing written yet
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toHaveLength(1);
    expect(writes[0].map((r) => r.message)).toEqual(['one', 'two']);
  });

  it('flushes early once 100 rows are buffered', async () => {
    const writes: ChatLogRow[][] = [];
    const logger = new ChatLogger(async (rows) => { writes.push(rows); });
    for (let i = 0; i < 100; i++) logger.log(row(`m${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(100);
  });

  it('stop() flushes whatever is left', async () => {
    const writes: ChatLogRow[][] = [];
    const logger = new ChatLogger(async (rows) => { writes.push(rows); });
    logger.log(row('last words'));
    await logger.stop();
    expect(writes).toHaveLength(1);
    expect(writes[0][0].message).toBe('last words');
  });

  it('re-queues rows when the write fails, then retries', async () => {
    const writes: ChatLogRow[][] = [];
    let fail = true;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ChatLogger(async (rows) => {
      if (fail) throw new Error('db down');
      writes.push(rows);
    });
    logger.log(row('survives the outage'));
    await vi.advanceTimersByTimeAsync(5000); // first flush fails, row re-queued
    expect(writes).toHaveLength(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000); // retry succeeds
    expect(writes).toHaveLength(1);
    expect(writes[0][0].message).toBe('survives the outage');
    errSpy.mockRestore();
  });

  it('caps the buffer so an unreachable DB cannot grow memory forever', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written: ChatLogRow[][] = [];
    let fail = true;
    const logger = new ChatLogger(async (rows) => {
      if (fail) throw new Error('db down');
      written.push(rows);
    });
    for (let i = 0; i < 6000; i++) {
      logger.log(row(`m${i}`));
      await vi.advanceTimersByTimeAsync(0); // let threshold flushes run (and fail)
    }
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    const total = written.flat().length;
    expect(total).toBeLessThanOrEqual(5000);
    expect(total).toBeGreaterThan(0);
    errSpy.mockRestore();
  });
});
