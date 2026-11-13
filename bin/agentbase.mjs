#!/usr/bin/env node
import { main } from '../dist/cli.js';
main().catch(error => {
  console.error(JSON.stringify({ error: error.code ?? 'ERROR', message: error.message }));
  process.exitCode = 1;
});
