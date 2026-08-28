import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { buildGrokArgs } from './argv';
import { translateGrokEvent } from './stream-json';

export interface GrokAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
}

type GrokChild = SpawnedProcessByStdio<null, Readable, Readable>;

export class GrokAdapter implements AgentAdapter {
  readonly id = 'grok';
  readonly displayName = 'Grok CLI';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: GrokAdapterOptions = {}) {
    this.binary = opts.binary ?? 'grok';
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'grok',
      agentName: 'Grok CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'grok binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for GrokAdapter.run');
    }

    // Grok headless mode does not read the prompt from stdin. Put both the
    // bridge system prompt and the user prompt in a temp file so special
    // characters never reach argv / cmd.exe.
    const promptFile = writePromptFile(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity));
    const args = buildGrokArgs({
      promptFile: promptFile.path,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      model: opts.model,
      permissionMode: opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      sandbox: opts.sandbox,
    });

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...buildLarkChannelEnv(this.larkChannel),
        GROK_DISABLE_AUTOUPDATER: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as GrokChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn grok: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      promptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      promptFile.cleanup();
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: GrokChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn grok: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateGrokEvent(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `grok runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `grok exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `grok runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

function writePromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-grok-'));
  const path = join(dir, 'prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
