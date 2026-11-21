import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexMeetingBridge } from '../electron/llm/codexBridge';
import { buildCodexMeetingPrompt } from '../electron/llm/prompts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCodex(delayMs = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-codex-'));
  dirs.push(dir);
  const binary = join(dir, 'codex');
  writeFileSync(binary, `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let activeTurn = null;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ id: msg.id, result: {} });
  if (msg.method === 'thread/start') {
    return send({ id: msg.id, result: { thread: { id: 'thread-new' } } });
  }
  if (msg.method === 'thread/resume') {
    return send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
  }
  if (msg.method === 'turn/start') {
    activeTurn = { threadId: msg.params.threadId, turnId: 'turn-1' };
    send({ id: msg.id, result: { turn: { id: activeTurn.turnId } } });
    setTimeout(() => {
      send({ method: 'item/agentMessage/delta', params: { ...activeTurn, itemId: 'item-1', delta: '先回答结论。' } });
      send({ method: 'item/agentMessage/delta', params: { ...activeTurn, itemId: 'item-1', delta: '再补充理由。' } });
      send({ method: 'turn/completed', params: { threadId: activeTurn.threadId, turn: { id: activeTurn.turnId, status: 'completed', items: [] } } });
    }, ${delayMs});
    return;
  }
  if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: activeTurn.threadId, turn: { id: activeTurn.turnId, status: 'interrupted', items: [] } } });
  }
});
`, 'utf8');
  chmodSync(binary, 0o755);
  return binary;
}

function request(
  bridge: CodexMeetingBridge,
  signal = new AbortController().signal,
  delayMs = 0,
) {
  const chunks: string[] = [];
  return bridge.answer({
    prompt: '对方问了一个问题',
    binary: fakeCodex(delayMs),
    workspace: process.cwd(),
    signal,
    onDelta: (text) => chunks.push(text),
  }).then((result) => ({ result, chunks }));
}

describe('CodexMeetingBridge', () => {
  it('builds a bounded teleprompter prompt with recent speech context', () => {
    const prompt = buildCodexMeetingPrompt({
      question: '为什么选 Redis？',
      recentTranscript: ['先介绍项目。', '为什么选 Redis？'],
      answerLang: 'chinese',
    });
    expect(prompt).toContain('“为什么选 Redis？”');
    expect(prompt).toContain('先介绍项目。');
    expect(prompt).toContain('用中文回答');
    expect(prompt).toContain('不要编造项目经历或数字');
  });

  it('creates a thread, streams assistant deltas and returns its id', async () => {
    const bridge = new CodexMeetingBridge();
    try {
      const { result, chunks } = await request(bridge);
      expect(result.threadId).toBe('thread-new');
      expect(result.text).toBe('先回答结论。再补充理由。');
      expect(chunks).toEqual(['先回答结论。', '再补充理由。']);
    } finally {
      bridge.stop();
    }
  });

  it('turns an AbortSignal into an interrupted Codex turn', async () => {
    const bridge = new CodexMeetingBridge();
    const controller = new AbortController();
    const pending = request(bridge, controller.signal, 3_000);
    setTimeout(() => controller.abort(), 30);
    try {
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      bridge.stop();
    }
  });
});
