#!/usr/bin/env node
/**
 * bin/ai-orchestrator.js — Executable entry point.
 * All behaviour lives in src/; this file only hands control to the CLI.
 */

import buildProgram from '../src/cli/index.js';

buildProgram().parseAsync(process.argv);
