/**
 * Discord interactive alert actions (acknowledge / snooze / re-route).
 *
 * Public surface consumed by `app.ts` and the alert dispatch path.
 */
export * from './discord-interactions.types';
export * from './discord-interactions.schema';
export {
  exportRawEd25519PublicKey,
  isFreshDiscordTimestamp,
  verifyDiscordRequest,
  verifyDiscordSignature,
  DISCORD_TIMESTAMP_TOLERANCE_MS,
  type DiscordVerificationResult,
} from './discord-interactions.signature';
export {
  InMemoryDiscordAlertActionStore,
  type ApplyAlertActionInput,
  type DiscordAlertActionEvent,
  type DiscordAlertActionState,
  type DiscordAlertActionStatus,
  type DiscordAlertActionStore,
} from './discord-interactions.actionStore';
export {
  DiscordInteractionsService,
  discordInteractionsService,
  MAX_SNOOZE_SECONDS,
  type DiscordInteractionsServiceOptions,
} from './discord-interactions.service';
export { DiscordInteractionsController, discordInteractionsController } from './discord-interactions.controller';
export { discordInteractionsRoutes } from './discord-interactions.routes';
export {
  createMockPayment,
  createMockPathPayment,
  createMockTrade,
  createMockSorobanEvent,
  type MockPaymentOverrides,
  type MockPathPaymentOverrides,
  type MockTradeOverrides,
  type MockSorobanEventOverrides,
} from '@stellar-alerts/shared/testing/horizon-fixtures';
