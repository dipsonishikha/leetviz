// Ad-hoc runner: node test/try.mjs <lang> <cmd> <file> '<meta json>' '<args json>'
import { readFileSync } from 'node:fs';
import { trace, measure, stress } from '../lib/runner.js';
const [lang, cmd, file, meta, args, gen] = process.argv.slice(2);
const code = readFileSync(file, 'utf8');
const req = { lang, code, meta: JSON.parse(meta), args: JSON.parse(args || '[]'), gen: gen && readFileSync(gen, 'utf8'), approaches: [{ name: 'A', code }], a: { code }, b: { code } };
const t0 = Date.now();
const r = await ({ trace, measure, stress })[cmd](req, (p) => process.stderr.write(JSON.stringify(p) + '\n'));
console.error(`${Date.now() - t0} ms`);
process.stdout.write(JSON.stringify(r, null, process.env.FULL ? 1 : 0) + '\n', () => process.exit(0));
