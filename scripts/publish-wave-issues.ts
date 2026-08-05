import fs from 'fs';
import path from 'path';

export interface WaveIssue {
  id: number;
  title: string;
  category: string;
  milestone: string;
  complexity: 'Trivial' | 'Medium' | 'High';
  estimatedPoints: number;
  labels: string[];
  summary: string;
  background: string;
  problemStatement: string;
  proposedSolution: string;
  filesLikelyAffected: string[];
  acceptanceCriteria: string[];
  testingRequirements: string[];
}

export const WAVE_ISSUES: WaveIssue[] = [
  {
    id: 1,
    title: "[FEAT]: Migrate Ingestion Watcher from Polling to Horizon Server-Sent Events (SSE) Stream",
    category: "Backend",
    milestone: "Milestone 3 – Reliability",
    complexity: "High",
    estimatedPoints: 8,
    labels: ["backend", "stellar", "performance"],
    summary: "Replace 10-second DB polling loop in watcher worker with Horizon SSE stream.",
    background: "Current watcher queries Horizon API on a set interval, introducing up to 10s latency.",
    problemStatement: "Polling creates unnecessary HTTP overhead on Horizon server and delays payment notification delivery.",
    proposedSolution: "Refactor stellar.ts to utilize server.payments().forAccount(key).cursor('now').stream() with reconnect logic.",
    filesLikelyAffected: ["apps/api/src/workers/watcher.worker.ts", "apps/api/src/lib/stellar.ts"],
    acceptanceCriteria: [
      "Payments trigger ingestion immediately (<500ms) upon ledger closing",
      "SSE stream automatically reconnects after network disconnects"
    ],
    testingRequirements: ["Unit test stream message handler", "Simulate network drop and verify stream reconnect"]
  },
  {
    id: 2,
    title: "[FEAT]: Implement Persistent Cursor Tracking Table in Prisma Schema",
    category: "Backend",
    milestone: "Milestone 1 – Foundation",
    complexity: "Medium",
    estimatedPoints: 5,
    labels: ["backend", "database"],
    summary: "Store last processed Horizon operation paging token per account in database.",
    background: "Watcher starts from current state on boot, risking missed payments during worker downtime.",
    problemStatement: "Worker restarts create transaction ingestion gaps.",
    proposedSolution: "Create IngestionCursor model in schema.prisma and load cursor token on watcher boot.",
    filesLikelyAffected: ["apps/api/prisma/schema.prisma", "apps/api/src/workers/watcher.worker.ts"],
    acceptanceCriteria: [
      "IngestionCursor record created per wallet",
      "Watcher resumes from exact cursor after restart"
    ],
    testingRequirements: ["Test database migration", "Verify worker paging token recovery"]
  },
  {
    id: 3,
    title: "[FEAT]: Build Multi-Asset Balance & Soroban Asset Contract (SAC) Decoders",
    category: "Backend",
    milestone: "Milestone 2 – Core Features",
    complexity: "High",
    estimatedPoints: 8,
    labels: ["backend", "stellar", "soroban"],
    summary: "Decode Soroban SAC token transfers and custom asset payment operations.",
    background: "Stellar ecosystem relies heavily on SAC tokens like USDC and PYUSD.",
    problemStatement: "Current parser extracts basic XLM native assets only.",
    proposedSolution: "Add helper to parse SAC transfer events and Horizon custom asset codes.",
    filesLikelyAffected: ["apps/api/src/lib/stellar.ts", "apps/api/src/workers/watcher.worker.ts"],
    acceptanceCriteria: [
      "Custom SAC tokens correctly parsed with decimals",
      "Asset code and issuer address recorded in DB"
    ],
    testingRequirements: ["Unit test SAC topic decoding logic"]
  },
  {
    id: 4,
    title: "[SEC]: Add Request Rate Limiting Middleware (@fastify/rate-limit)",
    category: "Security",
    milestone: "Milestone 1 – Foundation",
    complexity: "Trivial",
    estimatedPoints: 3,
    labels: ["api", "security"],
    summary: "Register rate limiting on Fastify API endpoints.",
    background: "API endpoints currently lack rate limiting.",
    problemStatement: "Backend is vulnerable to brute force and DDoS attacks.",
    proposedSolution: "Register @fastify/rate-limit plugin in app.ts with 100 req/min threshold.",
    filesLikelyAffected: ["apps/api/src/app.ts", "apps/api/package.json"],
    acceptanceCriteria: [
      "Exceeding rate limit returns HTTP 429",
      "Retry-After header included in response"
    ],
    testingRequirements: ["Integration test sending 101 requests"]
  },
  {
    id: 5,
    title: "[FEAT]: Implement Webhook Alert Endpoint Management API",
    category: "API",
    milestone: "Milestone 2 – Core Features",
    complexity: "Medium",
    estimatedPoints: 5,
    labels: ["api", "feature"],
    summary: "Build REST CRUD endpoints for user-registered webhook URLs.",
    background: "Users need custom webhook triggers for incoming payments.",
    problemStatement: "No endpoints exist to register or manage webhook targets.",
    proposedSolution: "Create /webhooks routes (POST, GET, DELETE, POST /:id/test).",
    filesLikelyAffected: ["apps/api/src/modules/webhooks/*"],
    acceptanceCriteria: [
      "Users can add, list, and delete custom webhook URLs",
      "Test endpoint dispatches ping payload"
    ],
    testingRequirements: ["Supertest route verification"]
  },
  {
    id: 6,
    title: "[DX]: Integrate Fastify Swagger & Scalar for OpenAPI Interactive Docs",
    category: "Documentation",
    milestone: "Milestone 5 – Developer Experience",
    complexity: "Trivial",
    estimatedPoints: 3,
    labels: ["api", "documentation", "dx"],
    summary: "Auto-generate interactive Swagger/OpenAPI documentation at /docs.",
    background: "Reviewers and developers require interactive API documentation.",
    problemStatement: "No OpenAPI specification is currently exposed.",
    proposedSolution: "Register @fastify/swagger and @fastify/swagger-ui plugins.",
    filesLikelyAffected: ["apps/api/src/app.ts", "apps/api/package.json"],
    acceptanceCriteria: [
      "Navigating to /docs renders interactive API documentation",
      "Zod schemas exported into OpenAPI component schemas"
    ],
    testingRequirements: ["Verify GET /docs returns 200 OK"]
  }
];

export function exportIssuesToJSON() {
  const outputPath = path.join(process.cwd(), 'docs', 'drips-wave-issues.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(WAVE_ISSUES, null, 2), 'utf-8');
  console.log(`[WaveExporter] 🚀 Exported ${WAVE_ISSUES.length} Drips Wave issues to ${outputPath}`);
}

if (require.main === module) {
  exportIssuesToJSON();
}
