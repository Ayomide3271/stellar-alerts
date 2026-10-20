/**
 * Tests for profile CLI commands.
 *
 * Strategy: test command registration/structure (Commander.js API) and action
 * behaviour with mocked profile-store, similar to how wallet.test.ts works.
 * This avoids filesystem side effects and keeps tests fast.
 *
 * Coverage:
 *  - Command tree registration (profile, create, list, use, show, update, remove)
 *  - Secret subcommand tree (secret set, get, list, delete)
 *  - Option/argument declarations
 *  - Successful action paths (via mocked store functions)
 *  - Error paths: PROFILE_NOT_FOUND, PROFILE_ALREADY_EXISTS, VAULT_WRONG_PASSWORD, etc.
 *  - Active profile display (profile list active marker)
 *  - Profile switching (profile use)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerProfileCommands } from './profile.js';
import { ProfileError } from '../lib/profile-types.js';

// ---------------------------------------------------------------------------
// Mock the entire profile-store module
// ---------------------------------------------------------------------------

vi.mock('../lib/profile-store.js', () => ({
  createProfileStore: vi.fn(() => ({ configDir: '/tmp/test-config' })),
  createProfile: vi.fn(),
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  getActiveProfileName: vi.fn(),
  getActiveProfile: vi.fn(),
  setActiveProfile: vi.fn(),
  updateProfile: vi.fn(),
  removeProfile: vi.fn(),
  setSecret: vi.fn(),
  getSecret: vi.fn(),
  listSecretKeys: vi.fn(),
  deleteSecret: vi.fn(),
  resolveEffectiveConfig: vi.fn(),
}));

import * as profileStore from '../lib/profile-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests
  registerProfileCommands(program);
  return program;
}

function findCmd(program: Command, ...path: string[]): Command {
  let cmd: Command = program;
  for (const name of path) {
    const found = cmd.commands.find((c) => c.name() === name);
    if (!found) throw new Error(`Command '${name}' not found in ${cmd.name()}`);
    cmd = found;
  }
  return cmd;
}

// Mock profile fixture
const mockProfile = {
  name: 'testnet',
  apiUrl: 'http://localhost:3001',
  network: 'testnet',
  logLevel: 'info' as const,
  hasSecrets: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

describe('profile commands – registration', () => {
  it('registers a top-level "profile" command', () => {
    const program = makeProgram();
    const profileCmd = program.commands.find((c) => c.name() === 'profile');
    expect(profileCmd).toBeDefined();
    expect(profileCmd!.description()).toBe('Manage CLI configuration profiles');
  });

  it('registers "profile create" subcommand', () => {
    const program = makeProgram();
    const createCmd = findCmd(program, 'profile', 'create');
    expect(createCmd.description()).toBe('Create a new configuration profile');
  });

  it('registers "profile list" subcommand', () => {
    const program = makeProgram();
    const listCmd = findCmd(program, 'profile', 'list');
    expect(listCmd.description()).toBe('List all configuration profiles');
    const jsonOption = listCmd.options.find((o) => o.long === '--json');
    expect(jsonOption).toBeDefined();
  });

  it('registers "profile use" subcommand', () => {
    const program = makeProgram();
    const useCmd = findCmd(program, 'profile', 'use');
    expect(useCmd.description()).toBe('Switch the active profile');
  });

  it('registers "profile show" subcommand', () => {
    const program = makeProgram();
    const showCmd = findCmd(program, 'profile', 'show');
    expect(showCmd.description()).toBe('Show profile details (defaults to active profile)');
  });

  it('registers "profile update" subcommand', () => {
    const program = makeProgram();
    const updateCmd = findCmd(program, 'profile', 'update');
    expect(updateCmd.description()).toBe("Update a profile's non-sensitive settings");
  });

  it('registers "profile remove" subcommand with alias rm', () => {
    const program = makeProgram();
    const removeCmd = findCmd(program, 'profile', 'remove');
    expect(removeCmd.description()).toBe('Delete a profile (and its vault secrets if password is supplied)');
    expect(removeCmd.alias()).toBe('rm');
  });

  it('registers "profile secret" subcommand', () => {
    const program = makeProgram();
    const secretCmd = findCmd(program, 'profile', 'secret');
    expect(secretCmd.description()).toBe('Manage secrets stored in the encrypted vault');
  });

  it('registers "profile secret set" subcommand', () => {
    const program = makeProgram();
    const setCmd = findCmd(program, 'profile', 'secret', 'set');
    expect(setCmd.description()).toBe('Store a secret value in the encrypted vault');
  });

  it('registers "profile secret get" subcommand', () => {
    const program = makeProgram();
    const getCmd = findCmd(program, 'profile', 'secret', 'get');
    expect(getCmd.description()).toBe('Retrieve a secret value from the encrypted vault');
  });

  it('registers "profile secret list" subcommand with alias ls', () => {
    const program = makeProgram();
    const listCmd = findCmd(program, 'profile', 'secret', 'list');
    expect(listCmd.description()).toBe('List secret keys stored in the vault (values are NOT shown)');
    expect(listCmd.alias()).toBe('ls');
  });

  it('registers "profile secret delete" subcommand with alias rm', () => {
    const program = makeProgram();
    const deleteCmd = findCmd(program, 'profile', 'secret', 'delete');
    expect(deleteCmd.description()).toBe('Delete a secret from the encrypted vault');
    expect(deleteCmd.alias()).toBe('rm');
  });
});

// ---------------------------------------------------------------------------
// Option/argument declarations
// ---------------------------------------------------------------------------

describe('profile commands – options', () => {
  it('"profile create" has --api-url option', () => {
    const program = makeProgram();
    const createCmd = findCmd(program, 'profile', 'create');
    const opts = createCmd.options;
    expect(opts.some((o: any) => o.long === '--api-url')).toBe(true);
  });

  it('"profile create" has --network option', () => {
    const program = makeProgram();
    const createCmd = findCmd(program, 'profile', 'create');
    const opts = createCmd.options;
    expect(opts.some((o: any) => o.long === '--network')).toBe(true);
  });

  it('"profile create" has --log-level option', () => {
    const program = makeProgram();
    const createCmd = findCmd(program, 'profile', 'create');
    const opts = createCmd.options;
    expect(opts.some((o: any) => o.long === '--log-level')).toBe(true);
  });

  it('"profile remove" has --password option', () => {
    const program = makeProgram();
    const removeCmd = findCmd(program, 'profile', 'remove');
    const opts = removeCmd.options;
    expect(opts.some((o: any) => o.long === '--password')).toBe(true);
  });

  it('"profile secret set" has --value option', () => {
    const program = makeProgram();
    const setCmd = findCmd(program, 'profile', 'secret', 'set');
    const opts = setCmd.options;
    expect(opts.some((o: any) => o.long === '--value')).toBe(true);
  });

  it('"profile secret set" has --profile-name option', () => {
    const program = makeProgram();
    const setCmd = findCmd(program, 'profile', 'secret', 'set');
    const opts = setCmd.options;
    expect(opts.some((o: any) => o.long === '--profile-name')).toBe(true);
  });

  it('"profile update" has --api-url, --network, --log-level options', () => {
    const program = makeProgram();
    const updateCmd = findCmd(program, 'profile', 'update');
    const opts = updateCmd.options;
    expect(opts.some((o: any) => o.long === '--api-url')).toBe(true);
    expect(opts.some((o: any) => o.long === '--network')).toBe(true);
    expect(opts.some((o: any) => o.long === '--log-level')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Action tests (mocked store)
// ---------------------------------------------------------------------------

describe('profile commands – actions', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  // ── profile list ──

  it('profile list: shows "no profiles" message when empty', async () => {
    vi.mocked(profileStore.listProfiles).mockReturnValue([]);
    vi.mocked(profileStore.getActiveProfileName).mockReturnValue(null);

    const program = makeProgram();
    await program.parseAsync(['profile', 'list'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No profiles found'),
    );
  });

  it('profile list: displays profiles when they exist', async () => {
    vi.mocked(profileStore.listProfiles).mockReturnValue([mockProfile]);
    vi.mocked(profileStore.getActiveProfileName).mockReturnValue('testnet');

    const program = makeProgram();
    await program.parseAsync(['profile', 'list'], { from: 'user' });

    // Should have logged something with the profile name
    const allLogs = consoleSpy.mock.calls.flat().join(' ');
    expect(allLogs).toContain('testnet');
  });

  it('profile list: outputs JSON when --json flag is passed', async () => {
    vi.mocked(profileStore.listProfiles).mockReturnValue([mockProfile]);

    const program = makeProgram();
    await program.parseAsync(['profile', 'list', '--json'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify([mockProfile], null, 2),
    );
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed).toEqual([mockProfile]);
  });

  // ── profile use ──

  it('profile use: calls setActiveProfile and logs success', async () => {
    vi.mocked(profileStore.setActiveProfile).mockReturnValue(undefined);

    const program = makeProgram();
    await program.parseAsync(['profile', 'use', 'testnet'], { from: 'user' });

    expect(profileStore.setActiveProfile).toHaveBeenCalledWith(
      expect.anything(),
      'testnet',
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Switched to profile'),
    );
  });

  it('profile use: exits with error for PROFILE_NOT_FOUND', async () => {
    vi.mocked(profileStore.setActiveProfile).mockImplementation(() => {
      throw new ProfileError('PROFILE_NOT_FOUND', "Profile 'ghost' not found.");
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const program = makeProgram();
    await program.parseAsync(['profile', 'use', 'ghost'], { from: 'user' });

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Profile 'ghost' not found."),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  // ── profile create ──

  it('profile create: calls createProfile with correct arguments', async () => {
    vi.mocked(profileStore.createProfile).mockReturnValue(mockProfile);
    vi.mocked(profileStore.getActiveProfileName).mockReturnValue('testnet');

    const program = makeProgram();
    await program.parseAsync(
      ['profile', 'create', 'testnet', '--api-url', 'http://localhost:3001', '--network', 'testnet'],
      { from: 'user' },
    );

    expect(profileStore.createProfile).toHaveBeenCalledWith(
      expect.anything(),
      'testnet',
      expect.objectContaining({ apiUrl: 'http://localhost:3001', network: 'testnet' }),
    );
  });

  it('profile create: logs error for PROFILE_ALREADY_EXISTS', async () => {
    vi.mocked(profileStore.createProfile).mockImplementation(() => {
      throw new ProfileError('PROFILE_ALREADY_EXISTS', "Profile 'testnet' already exists.");
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const program = makeProgram();
    await program.parseAsync(['profile', 'create', 'testnet'], { from: 'user' });

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Profile 'testnet' already exists."),
    );
    mockExit.mockRestore();
  });

  // ── profile show ──

  it('profile show: shows active profile when no name given', async () => {
    vi.mocked(profileStore.getActiveProfile).mockReturnValue(mockProfile);
    vi.mocked(profileStore.getActiveProfileName).mockReturnValue('testnet');

    const program = makeProgram();
    await program.parseAsync(['profile', 'show'], { from: 'user' });

    expect(profileStore.getActiveProfile).toHaveBeenCalled();
    const allLogs = consoleSpy.mock.calls.flat().join(' ');
    expect(allLogs).toContain('testnet');
  });

  it('profile show: shows named profile when name given', async () => {
    const mainnetProfile = { ...mockProfile, name: 'mainnet', apiUrl: 'https://horizon.stellar.org' };
    vi.mocked(profileStore.getProfile).mockReturnValue(mainnetProfile);
    vi.mocked(profileStore.getActiveProfileName).mockReturnValue('testnet');

    const program = makeProgram();
    await program.parseAsync(['profile', 'show', 'mainnet'], { from: 'user' });

    expect(profileStore.getProfile).toHaveBeenCalledWith(expect.anything(), 'mainnet');
  });

  // ── profile update ──

  it('profile update: logs warning when no fields provided', async () => {
    const program = makeProgram();
    await program.parseAsync(['profile', 'update', 'testnet'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No fields to update'),
    );
  });

  it('profile update: calls updateProfile with provided fields', async () => {
    vi.mocked(profileStore.updateProfile).mockReturnValue({ ...mockProfile, apiUrl: 'http://new:4000' });
    vi.mocked(profileStore.getActiveProfileName).mockReturnValue('testnet');

    const program = makeProgram();
    await program.parseAsync(
      ['profile', 'update', 'testnet', '--api-url', 'http://new:4000'],
      { from: 'user' },
    );

    expect(profileStore.updateProfile).toHaveBeenCalledWith(
      expect.anything(),
      'testnet',
      expect.objectContaining({ apiUrl: 'http://new:4000' }),
    );
  });

  // ── profile remove ──

  it('profile remove: calls removeProfile and logs success', async () => {
    vi.mocked(profileStore.getProfile).mockReturnValue({ ...mockProfile, hasSecrets: false });
    vi.mocked(profileStore.removeProfile).mockResolvedValue(undefined);

    const program = makeProgram();
    await program.parseAsync(['profile', 'remove', 'testnet'], { from: 'user' });

    expect(profileStore.removeProfile).toHaveBeenCalledWith(
      expect.anything(),
      'testnet',
      undefined, // no vault password supplied
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Profile 'testnet' removed"),
    );
  });

  it('profile remove: logs error for PROFILE_NOT_FOUND', async () => {
    vi.mocked(profileStore.getProfile).mockImplementation(() => {
      throw new ProfileError('PROFILE_NOT_FOUND', "Profile 'ghost' not found.");
    });
    vi.mocked(profileStore.removeProfile).mockImplementation(async () => {
      throw new ProfileError('PROFILE_NOT_FOUND', "Profile 'ghost' not found.");
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const program = makeProgram();
    await program.parseAsync(['profile', 'remove', 'ghost'], { from: 'user' });

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Profile 'ghost' not found."),
    );
    mockExit.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ProfileError codes surface correct hints
// ---------------------------------------------------------------------------

describe('profile commands – error hints', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('prints vault password hint on VAULT_WRONG_PASSWORD', async () => {
    vi.mocked(profileStore.setActiveProfile).mockImplementation(() => {
      throw new ProfileError('VAULT_WRONG_PASSWORD', 'Wrong password.');
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const program = makeProgram();
    await program.parseAsync(['profile', 'use', 'x'], { from: 'user' });

    const allErrors = consoleErrSpy.mock.calls.flat().join(' ');
    expect(allErrors).toContain('vault password');
    mockExit.mockRestore();
  });

  it('prints upgrade hint on VAULT_UNSUPPORTED_VERSION', async () => {
    vi.mocked(profileStore.setActiveProfile).mockImplementation(() => {
      throw new ProfileError('VAULT_UNSUPPORTED_VERSION', 'Unsupported version.');
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const program = makeProgram();
    await program.parseAsync(['profile', 'use', 'x'], { from: 'user' });

    const allErrors = consoleErrSpy.mock.calls.flat().join(' ');
    expect(allErrors).toContain('Upgrade');
    mockExit.mockRestore();
  });

  it('prints create hint on NO_ACTIVE_PROFILE', async () => {
    vi.mocked(profileStore.setActiveProfile).mockImplementation(() => {
      throw new ProfileError('NO_ACTIVE_PROFILE', 'No active profile.');
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const program = makeProgram();
    await program.parseAsync(['profile', 'use', 'x'], { from: 'user' });

    const allErrors = consoleErrSpy.mock.calls.flat().join(' ');
    expect(allErrors).toContain('profile create');
    mockExit.mockRestore();
  });
});
