/**
 * AUTO-GENERATED FILE. DO NOT EDIT BY HAND.
 *
 * Generated from the Fastify OpenAPI schema in apps/api/src/openapi.config.ts by
 * `npm run generate:types` (see scripts/generate-types.ts). Run that
 * command again after changing a Zod schema referenced by
 * `openApiComponentSchemas`, and commit the result.
 */
export type paths = Record<string, never>;
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        RequestLinkInput: {
            /** Format: email */
            email: string;
        };
        VerifyLinkInput: {
            token: string;
        };
        DIDChallengeInput: {
            did: string;
        };
        DIDVerifyInput: {
            did: string;
            challenge: string;
            signature: string;
        };
        CreateWalletInput: {
            publicKey: string;
            label?: string;
            tags?: string[];
            zkProof?: unknown;
            publicSignals?: string[];
        };
        CreateWebhookInput: {
            /** Format: uri */
            url: string;
            payloadTemplate?: string;
        };
        DeadLetterIdParams: {
            id: string;
        };
        ListDeadLettersQuery: {
            channel?: string;
            /** @enum {string} */
            status?: "pending" | "retried" | "suppressed";
            q?: string;
            maxAgeDays?: number;
            /** @default 20 */
            limit: number;
            cursor?: string;
        };
        SuppressDeadLetterInput: {
            note?: string;
        };
        SandboxReplayIdParams: {
            replayId: string;
        };
        SandboxReplayInput: {
            /** @default 200 */
            mockStatusCode: number;
            mockResponseBody?: string;
            mockResponseHeaders?: {
                [key: string]: string;
            };
        };
        ListSandboxReplaysQuery: {
            /** @default 20 */
            limit: number;
            cursor?: string;
        };
        ErrorResponse: {
            error: {
                /** @description Stable, machine-readable error code (e.g. VALIDATION_ERROR, NOT_FOUND, CONFLICT). */
                code: string;
                /** @description Human-readable, client-safe message. Never contains internal/sensitive detail. */
                message: string;
                /** @description Optional structured detail, e.g. field-level validation errors. */
                details?: unknown;
                /** @description Correlation id — also returned as the x-request-id response header. */
                requestId: string;
            };
        };
        CreateExportInput: {
            /** @enum {string} */
            type: "ledger_csv" | "ledger_pdf" | "tax_csv";
            walletId?: string;
            periodStart?: string;
            periodEnd?: string;
            /** @enum {string} */
            format?: "cointracker" | "koinly" | "irs8949";
        };
        ExportIdParams: {
            id: string;
        };
        ListExportsQuery: {
            /** @default 1 */
            page: number;
            /** @default 20 */
            pageSize: number;
        };
        DownloadExportQuery: {
            expires: number;
            sig: string;
        };
        AnalyzeSimulationInput: {
            sourceAccount: string;
            /** @enum {string} */
            network?: "PUBLIC" | "TESTNET" | "FUTURENET";
            label?: string;
            envelopeXdr?: string;
            operations: {
                /** @enum {string} */
                kind: "pay" | "pathPaymentStrictReceive" | "pathPaymentStrictSend" | "accountMerge" | "clawback" | "changeTrust" | "setTrustlineFlags" | "createAccount" | "createContract" | "uploadWasm" | "invokeContract" | "extendFootprintTtl" | "restoreFootprint" | "bumpSequence" | "setOptions" | "manageSellOffer" | "liquidityPoolWithdraw" | "unknown";
                source?: string;
                destination?: string;
                asset?: {
                    /** @enum {string} */
                    type: "native" | "credit_alphanumeric" | "liquidity_pool";
                    code?: string;
                    issuer?: string;
                    poolId?: string;
                };
                amount?: string;
                contractId?: string;
                function?: string;
                args?: unknown[];
                trustlineAsset?: {
                    /** @enum {string} */
                    type: "native" | "credit_alphanumeric" | "liquidity_pool";
                    code?: string;
                    issuer?: string;
                    poolId?: string;
                };
                trustlineFlagMask?: number;
            }[];
            resources?: {
                footprint?: {
                    readOnly?: {
                        key: string;
                        entryType: string;
                        contractId?: string;
                        /** @enum {string} */
                        access: "readOnly" | "readWrite" | "archived";
                    }[];
                    readWrite?: {
                        key: string;
                        entryType: string;
                        contractId?: string;
                        /** @enum {string} */
                        access: "readOnly" | "readWrite" | "archived";
                    }[];
                    archived?: {
                        key: string;
                        entryType: string;
                        contractId?: string;
                        /** @enum {string} */
                        access: "readOnly" | "readWrite" | "archived";
                    }[];
                };
                requiredFootprint?: {
                    readOnly?: {
                        key: string;
                        entryType: string;
                        contractId?: string;
                        /** @enum {string} */
                        access: "readOnly" | "readWrite" | "archived";
                    }[];
                    readWrite?: {
                        key: string;
                        entryType: string;
                        contractId?: string;
                        /** @enum {string} */
                        access: "readOnly" | "readWrite" | "archived";
                    }[];
                    archived?: {
                        key: string;
                        entryType: string;
                        contractId?: string;
                        /** @enum {string} */
                        access: "readOnly" | "readWrite" | "archived";
                    }[];
                };
                ledgerBounds?: {
                    min: number;
                    max: number;
                } | null;
                auth?: {
                    credentialsAddress?: string;
                    contractId?: string;
                    function?: string;
                }[];
                hasTimeBounds?: boolean;
                feeStroops?: string;
                operationCount?: number;
            };
            /** @default [] */
            preState: {
                accountId: string;
                nativeBalance?: string;
                balances?: {
                    asset: {
                        /** @enum {string} */
                        type: "native" | "credit_alphanumeric" | "liquidity_pool";
                        code?: string;
                        issuer?: string;
                        poolId?: string;
                    };
                    balance: string;
                    limit?: string;
                    revocable?: boolean;
                }[];
            }[];
            postState?: {
                accountId: string;
                nativeBalance?: string;
                balances?: {
                    asset: {
                        /** @enum {string} */
                        type: "native" | "credit_alphanumeric" | "liquidity_pool";
                        code?: string;
                        issuer?: string;
                        poolId?: string;
                    };
                    balance: string;
                    limit?: string;
                    revocable?: boolean;
                }[];
            }[];
            outcome?: {
                ledger?: number;
                success?: boolean;
                errors?: {
                    /** @enum {string} */
                    type: "custom_error" | "panic" | "host_error" | "invocation_error";
                    code?: number;
                    message: string;
                    contractId?: string;
                    function?: string;
                }[];
                resultingBalances?: {
                    accountId: string;
                    nativeBalance?: string;
                    balances?: {
                        asset: {
                            /** @enum {string} */
                            type: "native" | "credit_alphanumeric" | "liquidity_pool";
                            code?: string;
                            issuer?: string;
                            poolId?: string;
                        };
                        balance: string;
                        limit?: string;
                        revocable?: boolean;
                    }[];
                }[];
                events?: {
                    contractId?: string;
                    type?: string;
                    value?: unknown;
                }[];
                feeStroops?: string;
            };
            contracts?: {
                contractId: string;
                wasmHash?: string;
                deployed?: boolean;
                codeArchived?: boolean;
            }[];
            trustRegistry?: {
                byContractId?: {
                    [key: string]: {
                        contractId: string;
                        verified?: boolean;
                        wasmHash?: string;
                        deployer?: string;
                        verifiedAt?: string;
                    };
                };
                allowlist?: string[];
                trustedDeployers?: string[];
            };
        };
        SimulationIdParams: {
            id: string;
        };
        ListSimulationsQuery: {
            /** @default 1 */
            page: number;
            /** @default 20 */
            pageSize: number;
            /** @enum {string} */
            band?: "SAFE" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
            sourceAccount?: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
