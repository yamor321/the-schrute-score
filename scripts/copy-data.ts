/**
 * Pre-deploy step: publish data/latest.json (the pipeline's canonical output)
 * as site/data.json (what the dashboard fetches). Kept as two files so site/
 * only ever describes "what is currently published".
 */
import { copyFileSync, existsSync } from 'node:fs';

const from = 'data/latest.json';
const to = 'site/data.json';

if (!existsSync(from)) {
  console.error(`${from} does not exist — run \`npm run update\` first.`);
  process.exit(1);
}
copyFileSync(from, to);
console.log(`copied ${from} → ${to}`);
