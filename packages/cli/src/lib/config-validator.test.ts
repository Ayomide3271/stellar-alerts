import { describe, it, expect } from 'vitest';
import { ConfigValidator } from './config-validator.js';
import { ProfileError } from './profile-types.js';

describe('ConfigValidator', () => {
  it('validates a correct ProfilesFile structure', () => {
    const validConfig = {
      version: 1,
      activeProfile: 'main',
      profiles: {
        main: {
          name: 'main',
          apiUrl: 'https://api.stellar-alerts.com',
          createdAt: '2026-10-20T00:00:00Z',
          updatedAt: '2026-10-20T00:00:00Z',
          hasSecrets: true,
        },
      },
    };
    const validated = ConfigValidator.validate(validConfig, '/path/to/profiles.json');
    expect(validated.version).toBe(1);
    expect(validated.activeProfile).toBe('main');
  });

  it('rejects invalid schema version', () => {
    expect(() => ConfigValidator.validate({ version: 2, activeProfile: null, profiles: {} }, '/path/to/profiles.json')).toThrow(ProfileError);
  });
});
