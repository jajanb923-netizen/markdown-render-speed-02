// Driver for the markdown-render-speed-02 bounty.
// Reads /input/cases.json (or $MAKEFUN_INPUT_DIR/cases.json) and writes
// /output/html.json (or $MAKEFUN_OUTPUT_DIR/html.json): one rendered HTML
// string per input markdown document, in order. Erasable TypeScript only,
// so Node 22 runs it with type stripping and no build step.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
