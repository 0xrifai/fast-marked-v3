import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

// Driver for the make.fun markdown-render-speed-02 harness.
// Reads every case from /input/cases.json (or MAKEFUN_INPUT_DIR),
// renders each one with parse(), and writes /output/html.json
// (or MAKEFUN_OUTPUT_DIR) as a JSON array of HTML strings in order.
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const out = new Array(cases.length);
for (let i = 0; i < cases.length; i++) out[i] = parse(cases[i].markdown);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
