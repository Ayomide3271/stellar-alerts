import { ProfileError, ProfilesFile, isValidProfileName } from './profile-types.js';

export interface ValidationErrorDetail {
  path: string;
  expected: string;
  received: string;
  message: string;
}

export class ConfigValidator {
  public static createDefaultTemplate(): ProfilesFile {
    return {
      version: 1,
      activeProfile: null,
      profiles: {},
    };
  }

  public static validate(parsed: unknown, sourcePath: string): ProfilesFile {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ProfileError(
        'CONFIG_READ_ERROR',
        `Configuration error in ${sourcePath}: Root value must be an object, received ${Array.isArray(parsed) ? 'array' : typeof parsed}.`,
      );
    }

    const obj = parsed as Record<string, unknown>;
    const errors: ValidationErrorDetail[] = [];

    if (!('version' in obj)) {
      errors.push({ path: 'version', expected: '1', received: 'undefined', message: "Missing required property 'version'" });
    } else if (obj['version'] !== 1) {
      errors.push({ path: 'version', expected: '1 (integer)', received: String(obj['version']), message: "Property 'version' must equal 1" });
    }

    if (!('activeProfile' in obj)) {
      errors.push({ path: 'activeProfile', expected: 'string | null', received: 'undefined', message: "Missing required property 'activeProfile'" });
    } else if (obj['activeProfile'] !== null && typeof obj['activeProfile'] !== 'string') {
      errors.push({ path: 'activeProfile', expected: 'string | null', received: typeof obj['activeProfile'], message: "Property 'activeProfile' must be a string or null" });
    }

    if (!('profiles' in obj)) {
      errors.push({ path: 'profiles', expected: 'Record<string, ProfileConfig>', received: 'undefined', message: "Missing required property 'profiles'" });
    } else if (typeof obj['profiles'] !== 'object' || obj['profiles'] === null || Array.isArray(obj['profiles'])) {
      errors.push({ path: 'profiles', expected: 'object', received: Array.isArray(obj['profiles']) ? 'array' : typeof obj['profiles'], message: "Property 'profiles' must be a map of profile names to configs" });
    } else {
      const profiles = obj['profiles'] as Record<string, unknown>;
      for (const [profKey, profVal] of Object.entries(profiles)) {
        if (!isValidProfileName(profKey)) {
          errors.push({ path: `profiles.${profKey}`, expected: '1-64 alphanumeric, hyphens, or underscores', received: profKey, message: `Profile name '${profKey}' violates profile naming convention [a-zA-Z0-9_-]{1,64}` });
        }
        if (typeof profVal !== 'object' || profVal === null || Array.isArray(profVal)) {
          errors.push({ path: `profiles.${profKey}`, expected: 'ProfileConfig object', received: typeof profVal, message: `Profile entry '${profKey}' must be an object` });
          continue;
        }
        const p = profVal as Record<string, unknown>;
        if (typeof p['name'] !== 'string' || !isValidProfileName(p['name'])) {
          errors.push({ path: `profiles.${profKey}.name`, expected: 'valid profile name string', received: String(p['name']), message: `Field 'name' in profile '${profKey}' must match profile naming schema` });
        }
        if (typeof p['apiUrl'] !== 'string' || p['apiUrl'].trim() === '') {
          errors.push({ path: `profiles.${profKey}.apiUrl`, expected: 'non-empty URL string', received: typeof p['apiUrl'], message: `Field 'apiUrl' in profile '${profKey}' must be a valid non-empty string` });
        }
        if (typeof p['hasSecrets'] !== 'boolean') {
          errors.push({ path: `profiles.${profKey}.hasSecrets`, expected: 'boolean', received: typeof p['hasSecrets'], message: `Field 'hasSecrets' in profile '${profKey}' must be a boolean` });
        }
        if (typeof p['createdAt'] !== 'string') {
          errors.push({ path: `profiles.${profKey}.createdAt`, expected: 'ISO-8601 string', received: typeof p['createdAt'], message: `Field 'createdAt' in profile '${profKey}' must be an ISO-8601 string` });
        }
        if (typeof p['updatedAt'] !== 'string') {
          errors.push({ path: `profiles.${profKey}.updatedAt`, expected: 'ISO-8601 string', received: typeof p['updatedAt'], message: `Field 'updatedAt' in profile '${profKey}' must be an ISO-8601 string` });
        }
      }
    }

    if (errors.length > 0) {
      const formatted = errors.map(e => `  - [${e.path}] ${e.message}`).join('\n');
      throw new ProfileError('CONFIG_READ_ERROR', `Configuration error in ${sourcePath}:\n${formatted}`);
    }

    return parsed as ProfilesFile;
  }
}
