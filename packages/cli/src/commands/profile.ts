/**
 * Profile management commands for the Stellar Alerts CLI.
 *
 * Command tree:
 *   profile create <name>           – create a new profile (alias: add)
 *   profile list                    – list all profiles (alias: ls)
 *   profile use <name>              – switch the active profile
 *   profile show [name]             – show profile details
 *   profile update <name>           – update profile settings (alias: edit)
 *   profile remove <name>           – delete a profile (alias: rm)
 *   profile secret set <key>        – store a secret in the vault
 *   profile secret get <key>        – retrieve a secret from the vault
 *   profile secret list             – list secret keys (not values) (alias: ls)
 *   profile secret delete <key>     – delete a secret from the vault (alias: rm)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'node:readline';
import {
  createProfileStore,
  createProfile,
  listProfiles,
  getProfile,
  getActiveProfileName,
  getActiveProfile,
  setActiveProfile,
  updateProfile,
  removeProfile,
  setSecret,
  getSecret,
  listSecretKeys,
  deleteSecret,
} from '../lib/profile-store.js';
import { ProfileError, ProfileConfig } from '../lib/profile-types.js';

// ---------------------------------------------------------------------------
// Secure password prompt (no echo)
// ---------------------------------------------------------------------------

/**
 * Prompts the user for a password without echoing it to the terminal.
 * Falls back to visible input if stdin is not a TTY (CI / piped usage).
 */
async function promptPassword(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Non-interactive: read one line without suppression
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(promptText, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    // Interactive: suppress echo via raw mode
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    process.stdout.write(promptText);

    // Disable echo
    (process.stdin as any).setRawMode?.(true);
    process.stdin.resume();

    let password = '';

    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === '\r' || c === '\n') {
        process.stdout.write('\n');
        cleanup();
        resolve(password);
      } else if (c === '\u0003') {
        // Ctrl+C
        process.stdout.write('\n');
        cleanup();
        process.exit(1);
      } else if (c === '\u007f' || c === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
      } else {
        password += c;
      }
    };

    const cleanup = () => {
      (process.stdin as any).setRawMode?.(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      rl.close();
    };

    process.stdin.on('data', onData);
  });
}

async function promptPasswordConfirm(promptText: string): Promise<string> {
  const password = await promptPassword(promptText);
  const confirm = await promptPassword('Confirm vault password: ');

  if (password !== confirm) {
    console.error(chalk.red('❌ Passwords do not match. Please try again.'));
    process.exit(1);
  }

  return password;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatProfileRow(profile: ProfileConfig, isActive: boolean): string {
  const activeMarker = isActive ? chalk.green('●') : chalk.gray('○');
  const name = isActive ? chalk.bold.green(profile.name) : chalk.cyan(profile.name);
  const network = chalk.gray(profile.network ?? '—');
  const url = profile.apiUrl;
  const secrets = profile.hasSecrets ? chalk.yellow('🔒 yes') : chalk.gray('—');
  const updated = chalk.gray(new Date(profile.updatedAt).toLocaleDateString());
  return `${activeMarker}  ${name.padEnd(24)}${network.padEnd(12)}${url.padEnd(36)}${secrets.padEnd(12)}${updated}`;
}

function printProfilesTable(profiles: ProfileConfig[], activeName: string | null): void {
  const header =
    '   ' +
    chalk.bold('Name'.padEnd(24)) +
    chalk.bold('Network'.padEnd(12)) +
    chalk.bold('API URL'.padEnd(36)) +
    chalk.bold('Secrets'.padEnd(12)) +
    chalk.bold('Updated');

  console.log(chalk.gray('─'.repeat(100)));
  console.log(header);
  console.log(chalk.gray('─'.repeat(100)));

  for (const profile of profiles) {
    console.log(formatProfileRow(profile, profile.name === activeName));
  }

  console.log(chalk.gray('─'.repeat(100)));
}

function printProfileDetail(profile: ProfileConfig, isActive: boolean): void {
  const activeLabel = isActive ? chalk.green(' (active)') : '';
  console.log('');
  console.log(chalk.bold.blue(`📋 Profile: ${profile.name}${activeLabel}`));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  Network:    ${chalk.cyan(profile.network ?? '—')}`);
  console.log(`  API URL:    ${chalk.cyan(profile.apiUrl)}`);
  console.log(`  Log Level:  ${chalk.cyan(profile.logLevel ?? 'info')}`);
  console.log(`  Secrets:    ${profile.hasSecrets ? chalk.yellow('🔒 stored in vault') : chalk.gray('none')}`);
  console.log(`  Created:    ${chalk.gray(profile.createdAt)}`);
  console.log(`  Updated:    ${chalk.gray(profile.updatedAt)}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleProfileError(error: unknown): never {
  if (error instanceof ProfileError) {
    console.error(chalk.red(`❌ ${error.message}`));

    // Contextual hints
    switch (error.code) {
      case 'VAULT_WRONG_PASSWORD':
        console.error(chalk.yellow('   Tip: Check your vault password and try again.'));
        break;
      case 'VAULT_NOT_FOUND':
        console.error(chalk.yellow("   Tip: Set a secret first with: profile secret set <key>"));
        break;
      case 'VAULT_UNSUPPORTED_VERSION':
        console.error(chalk.yellow('   Tip: Upgrade the Stellar Alerts CLI.'));
        break;
      case 'NO_ACTIVE_PROFILE':
        console.error(chalk.yellow('   Tip: Create a profile with: profile create <name>'));
        break;
    }
  } else {
    console.error(chalk.red(`❌ Unexpected error: ${(error as Error).message}`));
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerProfileCommands(program: Command): void {
  const profileCmd = program
    .command('profile')
    .description('Manage CLI configuration profiles');

  // ── profile create ────────────────────────────────────────────────────────

  profileCmd
    .command('create <name>')
    .alias('add')
    .description('Create a new configuration profile')
    .option('-u, --api-url <url>', 'API base URL for this profile', 'http://localhost:3001')
    .option(
      '-n, --network <network>',
      'Network label (testnet, mainnet, staging, or custom)',
      'testnet',
    )
    .option(
      '--log-level <level>',
      'Log level (debug, info, warn, error)',
      'info',
    )
    .action(
      async (
        name: string,
        options: { apiUrl: string; network: string; logLevel: string },
      ) => {
        try {
          const store = createProfileStore();
          const profile = createProfile(store, name, {
            apiUrl: options.apiUrl,
            network: options.network,
            logLevel: options.logLevel as ProfileConfig['logLevel'],
          });

          console.log(chalk.green(`✅ Profile '${chalk.bold(profile.name)}' created successfully!`));
          printProfileDetail(profile, profile.name === getActiveProfileName(store));
        } catch (err) {
          handleProfileError(err);
        }
      },
    );

  // ── profile list ──────────────────────────────────────────────────────────

  profileCmd
    .command('list')
    .alias('ls')
    .description('List all configuration profiles')
    .option('--json', 'Output results in JSON format')
    .action(async (options: { json?: boolean }) => {
      try {
        const store = createProfileStore();
        const profiles = listProfiles(store);

        if (options.json) {
          console.log(JSON.stringify(profiles, null, 2));
          return;
        }

        if (profiles.length === 0) {
          console.log(
            chalk.yellow('📭 No profiles found. Create one with: stellar-alerts-cli profile create <name>'),
          );
          return;
        }

        const activeName = getActiveProfileName(store);
        console.log(chalk.blue(`\n🗂  Configuration Profiles (${profiles.length})\n`));
        printProfilesTable(profiles, activeName);
        console.log('');
      } catch (err) {
        handleProfileError(err);
      }
    });

  // ── profile use ───────────────────────────────────────────────────────────

  profileCmd
    .command('use <name>')
    .description('Switch the active profile')
    .action(async (name: string) => {
      try {
        const store = createProfileStore();
        setActiveProfile(store, name);
        console.log(chalk.green(`✅ Switched to profile '${chalk.bold(name)}'.`));
      } catch (err) {
        handleProfileError(err);
      }
    });

  // ── profile show ──────────────────────────────────────────────────────────

  profileCmd
    .command('show [name]')
    .description('Show profile details (defaults to active profile)')
    .action(async (name?: string) => {
      try {
        const store = createProfileStore();
        let profile: ProfileConfig;

        if (name) {
          profile = getProfile(store, name);
        } else {
          profile = getActiveProfile(store);
        }

        const activeName = getActiveProfileName(store);
        printProfileDetail(profile, profile.name === activeName);
      } catch (err) {
        handleProfileError(err);
      }
    });

  // ── profile update ────────────────────────────────────────────────────────

  profileCmd
    .command('update <name>')
    .alias('edit')
    .description('Update a profile\'s non-sensitive settings')
    .option('-u, --api-url <url>', 'New API base URL')
    .option('-n, --network <network>', 'New network label')
    .option('--log-level <level>', 'New log level (debug, info, warn, error)')
    .action(
      async (
        name: string,
        options: { apiUrl?: string; network?: string; logLevel?: string },
      ) => {
        try {
          const store = createProfileStore();

          const updates: Partial<Omit<ProfileConfig, 'name' | 'createdAt' | 'updatedAt' | 'hasSecrets'>> = {};
          if (options.apiUrl !== undefined) updates.apiUrl = options.apiUrl;
          if (options.network !== undefined) updates.network = options.network;
          if (options.logLevel !== undefined) {
            updates.logLevel = options.logLevel as ProfileConfig['logLevel'];
          }

          if (Object.keys(updates).length === 0) {
            console.log(chalk.yellow('⚠️  No fields to update. Use --api-url, --network, or --log-level.'));
            return;
          }

          const updated = updateProfile(store, name, updates);
          console.log(chalk.green(`✅ Profile '${chalk.bold(name)}' updated.`));
          printProfileDetail(updated, name === getActiveProfileName(store));
        } catch (err) {
          handleProfileError(err);
        }
      },
    );

  // ── profile remove ────────────────────────────────────────────────────────

  profileCmd
    .command('remove <name>')
    .alias('rm')
    .description('Delete a profile (and its vault secrets if password is supplied)')
    .option('-p, --password <password>', 'Vault password to also remove stored secrets')
    .action(async (name: string, options: { password?: string }) => {
      try {
        const store = createProfileStore();
        let vaultPassword = options.password;

        // If profile has secrets and no password was supplied, prompt interactively
        let profile: ProfileConfig | null = null;
        try {
          profile = getProfile(store, name);
        } catch {
          // will throw again inside removeProfile — let it propagate
        }

        if (profile?.hasSecrets && !vaultPassword && process.stdin.isTTY) {
          console.log(
            chalk.yellow(
              `⚠️  Profile '${name}' has vault secrets. Enter the vault password to remove them,\n` +
              `   or press Enter to skip (secrets will remain in vault).`,
            ),
          );
          const entered = await promptPassword('Vault password (optional): ');
          if (entered) vaultPassword = entered;
        }

        await removeProfile(store, name, vaultPassword);
        console.log(chalk.green(`✅ Profile '${chalk.bold(name)}' removed.`));
      } catch (err) {
        handleProfileError(err);
      }
    });

  // ── profile secret ────────────────────────────────────────────────────────

  const secretCmd = profileCmd
    .command('secret')
    .description('Manage secrets stored in the encrypted vault');

  // profile secret set <key>
  secretCmd
    .command('set <key>')
    .description('Store a secret value in the encrypted vault')
    .option(
      '--profile-name <profileName>',
      'Profile to store the secret for (defaults to active profile)',
    )
    .option('--value <value>', 'Secret value (if not provided, will prompt securely)')
    .action(async (key: string, options: { profileName?: string; value?: string }) => {
      try {
        const store = createProfileStore();
        const profileName =
          options.profileName ?? getActiveProfile(store).name;

        // Verify profile exists
        getProfile(store, profileName);

        const value =
          options.value ?? (await promptPassword(`Secret value for '${key}': `));

        if (!value) {
          console.error(chalk.red('❌ Secret value cannot be empty.'));
          process.exit(1);
        }

        const password = await promptPasswordConfirm('Vault password: ');

        await setSecret(store, profileName, key, value, password);
        console.log(
          chalk.green(`✅ Secret '${chalk.bold(key)}' stored for profile '${chalk.bold(profileName)}'.`),
        );
      } catch (err) {
        handleProfileError(err);
      }
    });

  // profile secret get <key>
  secretCmd
    .command('get <key>')
    .description('Retrieve a secret value from the encrypted vault')
    .option(
      '--profile-name <profileName>',
      'Profile to retrieve the secret for (defaults to active profile)',
    )
    .action(async (key: string, options: { profileName?: string }) => {
      try {
        const store = createProfileStore();
        const profileName =
          options.profileName ?? getActiveProfile(store).name;

        getProfile(store, profileName);

        const password = await promptPassword('Vault password: ');
        const value = await getSecret(store, profileName, key, password);

        if (value === undefined) {
          console.log(chalk.yellow(`⚠️  No secret '${key}' found for profile '${profileName}'.`));
          process.exit(1);
        }

        // Print to stdout so it can be piped safely
        process.stdout.write(value + '\n');
      } catch (err) {
        handleProfileError(err);
      }
    });

  // profile secret list
  secretCmd
    .command('list')
    .alias('ls')
    .description('List secret keys stored in the vault (values are NOT shown)')
    .option(
      '--profile-name <profileName>',
      'Profile to list secrets for (defaults to active profile)',
    )
    .action(async (options: { profileName?: string }) => {
      try {
        const store = createProfileStore();
        const profileName =
          options.profileName ?? getActiveProfile(store).name;

        getProfile(store, profileName);

        const password = await promptPassword('Vault password: ');
        const keys = await listSecretKeys(store, profileName, password);

        if (keys.length === 0) {
          console.log(chalk.yellow(`📭 No secrets stored for profile '${profileName}'.`));
          return;
        }

        console.log(chalk.blue(`\n🔒 Secrets for profile '${chalk.bold(profileName)}'\n`));
        for (const k of keys) {
          console.log(`  ${chalk.cyan('•')} ${k}`);
        }
        console.log('');
      } catch (err) {
        handleProfileError(err);
      }
    });

  // profile secret delete <key>
  secretCmd
    .command('delete <key>')
    .alias('rm')
    .description('Delete a secret from the encrypted vault')
    .option(
      '--profile-name <profileName>',
      'Profile to delete the secret from (defaults to active profile)',
    )
    .action(async (key: string, options: { profileName?: string }) => {
      try {
        const store = createProfileStore();
        const profileName =
          options.profileName ?? getActiveProfile(store).name;

        getProfile(store, profileName);

        const password = await promptPassword('Vault password: ');
        await deleteSecret(store, profileName, key, password);
        console.log(
          chalk.green(
            `✅ Secret '${chalk.bold(key)}' deleted from profile '${chalk.bold(profileName)}'.`,
          ),
        );
      } catch (err) {
        handleProfileError(err);
      }
    });
}
