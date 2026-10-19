import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, UserPayload } from '../utils/jwt';
import { isTokenRevoked } from '../lib/tokenBlocklist';
import { isFamilyRevoked } from '../lib/session-manager';
import { AuthenticationError } from '../lib/errors';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserPayload;
  }
}

/**
 * The primary authentication gate for nearly every protected route in the
 * API (auth, wallets, payments, webhooks, dead-letters, notifications).
 * Throws AuthenticationError (see lib/errors.ts) rather than replying
 * directly, so every one of those routes' 401s goes through the same
 * error envelope as everything else — this used to hand-roll its own
 * `{ error, message, code }` shape independently of the rest of the API.
 */
export async function authenticateHook(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthenticationError('You must be logged in to perform this action.', 'AUTH_REQUIRED');
  }

  const token = authHeader.split(' ')[1];
  let decoded: UserPayload;

  try {
    decoded = verifyToken<UserPayload>(token);
  } catch (error) {
    throw new AuthenticationError('Invalid or expired session token.', 'INVALID_TOKEN');
  }

  // Check Redis blocklist — reject if token has been explicitly revoked (logout).
  if (decoded.jti) {
    try {
  // PR placeholder for issue #532 – JWT session revocation
    const revoked = await isTokenRevoked(decoded.jti);
      if (revoked) {
        throw new AuthenticationError('Session has been revoked. Please log in again.', 'TOKEN_REVOKED');
      }
    } catch (redisError: any) {
      if (redisError instanceof AuthenticationError) throw redisError;
      // Fail-open: if Redis is unreachable, do not block the request.
      // Log the error so operators can investigate.
      request.log.error(`[Auth] Redis blocklist check failed: ${redisError.message}`);
    }
  }

  // Check session family revocation (access token rotation & reuse detection #315)
  if (decoded.familyId) {
    try {
      const familyRevoked = await isFamilyRevoked(decoded.familyId);
      if (familyRevoked) {
        throw new AuthenticationError('Session family has been revoked. Please log in again.', 'SESSION_REVOKED');
      }
    } catch (famErr: any) {
      if (famErr instanceof AuthenticationError) throw famErr;
      request.log.error(`[Auth] Family revocation check failed: ${famErr.message}`);
    }
  }

  request.user = decoded;
}
