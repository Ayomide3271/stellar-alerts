import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSandboxCommands, resolveSandboxOptions, startSandbox } from './sandbox.js';

const baseOptions = {
  host: '127.0.0.1',
  port: '0',
  rate: '1/s',
  accounts: '5',
  ledgerInterval: '5000',
};

describe('dev-sandbox command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('registers dev-sandbox with rate and drop flags', () => {
    const program = new Command();
    registerSandboxCommands(program);
    const cmd = program.commands.find((c) => c.name() === 'dev-sandbox');
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining(['--port', '--rate', '--drop-every', '--drop-duration', '--accounts', '--seed'])
    );
    expect(cmd!.options.find((o) => o.long === '--port')!.defaultValue).toBe('8000');
  });

  it('resolves flag strings into server options', () => {
    expect(
      resolveSandboxOptions({ ...baseOptions, rate: '30/m', dropEvery: '10', dropDuration: '250', seed: '7' })
    ).toMatchObject({ rate: 0.5, dropEvery: 10, dropDurationMs: 250, seed: 7, port: 0 });
  });

  it.each([
    [{ rate: 'quick' }, /--rate/],
    [{ port: '70000' }, /--port/],
    [{ accounts: '1' }, /--accounts/],
    [{ dropEvery: '-3' }, /--drop-every/],
  ])('rejects invalid options %j', (override, message) => {
    expect(() => resolveSandboxOptions({ ...baseOptions, ...override })).toThrow(message);
  });

  it('reports invalid flags through the command and sets a failing exit code', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerSandboxCommands(program);
    await program.parseAsync(['node', 'cli', 'dev-sandbox', '--rate', 'quick']);
    expect(error.mock.calls[0][0]).toContain('--rate');
    expect(process.exitCode).toBe(1);
  });

  it('shuts down cleanly on SIGINT and removes its signal handlers', async () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sandbox = await startSandbox({ port: 0, rate: 0, ledgerIntervalMs: 0 });
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);

    const res = await fetch(`${sandbox.server.url}/payments/stream`);
    await vi.waitFor(() => expect(sandbox.server.streamCount).toBe(1));

    process.emit('SIGINT');
    await sandbox.closed;

    expect(sandbox.server.isListening).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    // The open stream is ended, not left hanging.
    const reader = res.body!.getReader();
    while (!(await reader.read()).done);
    await expect(fetch(`${sandbox.server.url}/`)).rejects.toThrow();
  });

  it('shuts down cleanly on SIGTERM', async () => {
    const sandbox = await startSandbox({ port: 0, rate: 0, ledgerIntervalMs: 0 });
    process.emit('SIGTERM');
    await sandbox.closed;
    expect(sandbox.server.isListening).toBe(false);
  });
});
