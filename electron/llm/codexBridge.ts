/**
 * Codex CLI meeting bridge.
 *
 * MeetingCopilot already has the useful realtime primitives: audio capture,
 * ASR, question detection and an answer overlay. This bridge only replaces the
 * final answer backend. It talks to Codex's local app-server over stdio so a
 * configurable thread can retain project context and be resumed in Codex CLI.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface } from 'readline';

type JsonObject = Record<string, unknown>;

interface RpcError {
  code?: number;
  message?: string;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: RpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  text: string;
  onDelta: (text: string) => void;
  resolve: (text: string) => void;
  reject: (reason: Error) => void;
  signal: AbortSignal;
  abortListener?: () => void;
}

export interface CodexAnswerRequest {
  prompt: string;
  binary: string;
  workspace: string;
  profileHome?: string;
  threadId?: string;
  model?: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

export interface CodexAnswerResult {
  text: string;
  threadId: string;
}

const INITIALIZE_TIMEOUT_MS = 20_000;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function responseThreadId(result: unknown): string | undefined {
  const root = asObject(result);
  const thread = asObject(root?.thread);
  return typeof thread?.id === 'string' ? thread.id : undefined;
}

function responseTurnId(result: unknown): string | undefined {
  const root = asObject(result);
  const turn = asObject(root?.turn);
  return typeof turn?.id === 'string' ? turn.id : undefined;
}

function completedAnswer(turn: JsonObject): string {
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = asObject(items[i]);
    if (item?.type !== 'agent_message') continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .map((part) => {
        const p = asObject(part);
        return typeof p?.text === 'string' ? p.text : '';
      })
      .join('');
    if (text.trim()) return text;
  }
  return '';
}

/**
 * One app-server process per MeetingCopilot process. Requests are serialized so
 * two questions cannot contend for the same Codex thread.
 */
export class CodexMeetingBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private stderrTail = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private active: ActiveTurn | null = null;
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;

  answer(request: CodexAnswerRequest): Promise<CodexAnswerResult> {
    const result = this.queue
      .catch(() => undefined)
      .then(() => this.runAnswer(request));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  stop(): void {
    this.fail(new Error('Codex bridge stopped'));
    this.child?.kill();
    this.child = null;
    this.lines?.close();
    this.lines = null;
    this.initialized = false;
  }

  private async runAnswer(request: CodexAnswerRequest): Promise<CodexAnswerResult> {
    if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await this.ensureStarted(request.binary, request.workspace, request.profileHome);
    const threadId = await this.ensureThread(request);
    if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const turnParams: JsonObject = {
      threadId,
      cwd: request.workspace,
      input: [{ type: 'text', text: request.prompt }],
      approvalPolicy: 'never',
      ...(request.model ? { model: request.model } : {}),
    };
    const resultPromise = new Promise<string>((resolve, reject) => {
      this.active = {
        threadId,
        text: '',
        resolve,
        reject,
        signal: request.signal,
        onDelta: request.onDelta,
      };
    });

    const active = this.active;
    if (active) {
      active.abortListener = () => {
        if (!active.turnId) return;
        void this.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId })
          .catch(() => undefined);
      };
      request.signal.addEventListener('abort', active.abortListener, { once: true });
    }

    try {
      const started = await this.request('turn/start', turnParams);
      if (active) {
        active.turnId = responseTurnId(started);
        if (active.signal.aborted && active.turnId) {
          void this.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId })
            .catch(() => undefined);
        }
      }
      const text = await resultPromise;
      return { text, threadId };
    } catch (error) {
      this.clearActive();
      throw error;
    } finally {
      this.clearActive();
    }
  }

  private async ensureStarted(binary: string, workspace: string, profileHome?: string): Promise<void> {
    if (this.child && this.initialized) return;
    if (this.child) this.stop();

    const executable = binary.trim() || 'codex';
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd: workspace || process.cwd(),
      env: profileHome ? { ...process.env, CODEX_HOME: profileHome } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderrTail = '';
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => this.fail(new Error(`Codex 启动失败: ${error.message}`)));
    child.on('close', (code) => {
      if (this.child === child) {
        const tail = this.stderrTail.trim();
        this.fail(new Error(`Codex app-server 已退出 (${code ?? 'unknown'})${tail ? `: ${tail}` : ''}`));
        this.child = null;
        this.lines?.close();
        this.lines = null;
        this.initialized = false;
      }
    });

    const initialized = this.request('initialize', {
      clientInfo: { name: 'meeting-copilot', title: 'MeetingCopilot', version: '0.2.0' },
    });
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex app-server 初始化超时')), INITIALIZE_TIMEOUT_MS);
      void initialized.finally(() => clearTimeout(timer));
    });
    await Promise.race([initialized, timeout]);
    this.notify('initialized');
    this.initialized = true;
  }

  private async ensureThread(request: CodexAnswerRequest): Promise<string> {
    const common: JsonObject = {
      cwd: request.workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ...(request.model ? { model: request.model } : {}),
    };
    const result = request.threadId?.trim()
      ? await this.request('thread/resume', { threadId: request.threadId.trim(), ...common })
      : await this.request('thread/start', {
          ...common,
          developerInstructions:
            'You are embedded in a live meeting copilot. Answer the other party directly and concisely in the requested language. Preserve project context in this thread. Do not modify files.',
        });
    const threadId = responseThreadId(result);
    if (!threadId) throw new Error('Codex 没有返回会话 ID');
    return threadId;
  }

  private request(method: string, params?: JsonObject): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error('Codex app-server 未运行'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method) {
      // Interactive approvals should not block an answer that is constrained
      // to the read-only sandbox. Reject any unsolicited server request.
      this.writeMessage({
        id: message.id,
        error: { code: -32601, message: 'Unsupported by MeetingCopilot' },
      });
      return;
    }

    if (message.id !== undefined) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(message.error.message || `Codex request failed (${message.error.code ?? 'unknown'})`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const active = this.active;
    if (!active) return;
    const params = message.params ?? {};
    if (params.threadId !== active.threadId) return;

    if (message.method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (!delta) return;
      active.text += delta;
      active.onDelta(delta);
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = asObject(params.turn);
      if (!turn) return;
      if (active.turnId && typeof turn.id === 'string' && turn.id !== active.turnId) return;
      const status = typeof turn.status === 'string' ? turn.status : 'failed';
      if (status === 'completed') {
        const fallback = completedAnswer(turn);
        active.resolve(active.text || fallback);
      } else if (status === 'interrupted') {
        active.reject(new DOMException('Aborted', 'AbortError'));
      } else {
        const error = asObject(turn.error);
        active.reject(new Error(typeof error?.message === 'string' ? error.message : `Codex turn ${status}`));
      }
      this.clearActive();
    }
  }

  private writeMessage(message: JsonObject): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private clearActive(): void {
    const active = this.active;
    if (!active) return;
    if (active.abortListener) active.signal.removeEventListener('abort', active.abortListener);
    this.active = null;
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.active) {
      this.active.reject(error);
      this.clearActive();
    }
  }
}
