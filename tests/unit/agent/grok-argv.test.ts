import { describe, expect, it } from 'vitest';
import { buildGrokArgs, grokSandboxProfile } from '../../../src/agent/grok/argv.js';

describe('buildGrokArgs', () => {
  it('emits a headless prompt-file contract with default permission mode', () => {
    expect(
      buildGrokArgs({
        promptFile: '/tmp/prompt.md',
        cwd: '/repo',
      }),
    ).toEqual([
      '--prompt-file',
      '/tmp/prompt.md',
      '--output-format',
      'streaming-messages-json',
      '--permission-mode',
      'bypassPermissions',
      '--cwd',
      '/repo',
      '--no-auto-update',
      '--verbatim',
    ]);
  });

  it('appends resume, model, and mapped sandbox after the base flags', () => {
    expect(
      buildGrokArgs({
        promptFile: '/tmp/prompt.md',
        cwd: '/repo',
        sessionId: 'sess-1',
        model: 'grok-4.6',
        permissionMode: 'acceptEdits',
        sandbox: 'workspace-write',
      }),
    ).toEqual([
      '--prompt-file',
      '/tmp/prompt.md',
      '--output-format',
      'streaming-messages-json',
      '--permission-mode',
      'acceptEdits',
      '--cwd',
      '/repo',
      '--no-auto-update',
      '--verbatim',
      '--sandbox',
      'workspace',
      '--resume',
      'sess-1',
      '--model',
      'grok-4.6',
    ]);
  });

  it('maps sandbox modes onto Grok profiles and omits full access', () => {
    expect(grokSandboxProfile('read-only')).toBe('read-only');
    expect(grokSandboxProfile('workspace-write')).toBe('workspace');
    expect(grokSandboxProfile('danger-full-access')).toBeUndefined();
    expect(grokSandboxProfile(undefined)).toBeUndefined();
  });
});
