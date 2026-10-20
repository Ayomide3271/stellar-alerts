#!/usr/bin/env node

// Reuse the CI detectors and redacted diagnostics for the local pre-commit check.
import { main } from '../tools/check-secrets.mjs';

main(['--staged']);
