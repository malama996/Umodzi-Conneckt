/**
 * Measures the deterministic keyword classifier that the app actually uses
 * (frontend/lib/classification.ts) against docs/evaluation/classification-corpus.json.
 *
 * Run from the repository root:
 *   npx --no-install tsx docs/evaluation/eval-classify.ts
 * (tsx is installed in backend/node_modules, so use: cd backend && npx --no-install tsx ../docs/evaluation/eval-classify.ts)
 *
 * Produces: overall accuracy, per-category precision/recall/F1, the confusion
 * matrix, and a machine-readable JSON file for the report tables.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  classifyFaultWithEvidence,
  classifyFault,
} from '../../frontend/lib/classification';

type Item = { id: string; expected: string; description: string };

const here = dirname(fileURLToPath(import.meta.url));
const corpus: Item[] = JSON.parse(
  readFileSync(resolve(here, 'classification-corpus.json'), 'utf8'),
);

const splitArg = process.argv.find((a) => a.startsWith('--split='));
const split = splitArg ? splitArg.split('=')[1] : 'all';
const items = split === 'all' ? corpus : corpus.filter((c) => c.split === split);
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outName = outArg ? outArg.split('=')[1] : 'classification-results.json';
const labels = Array.from(new Set(corpus.map((c) => c.expected)));

const confusion: Record<string, Record<string, number>> = {};
for (const a of labels) {
  confusion[a] = {};
  for (const b of [...labels, '(none)']) confusion[a][b] = 0;
}

const rows: Array<{ id: string; expected: string; predicted: string; correct: boolean }> = [];

for (const item of items) {
  const predicted = classifyFault(item.description) || '(none)';
  const key = labels.includes(predicted) ? predicted : '(none)';
  confusion[item.expected][key] += 1;
  rows.push({
    id: item.id,
    expected: item.expected,
    predicted,
    correct: predicted === item.expected,
  });
}

const correct = rows.filter((r) => r.correct).length;
const accuracy = (correct / rows.length) * 100;

let macroP = 0;
let macroR = 0;
let macroF = 0;
const perCategory = labels.map((label) => {
  const tp = confusion[label][label];
  const fp = labels.reduce((sum, other) => (other === label ? sum : sum + confusion[other][label]), 0);
  const fn = Object.entries(confusion[label]).reduce(
    (sum, [other, n]) => (other === label ? sum : sum + n),
    0,
  );
  const precision = tp + fp === 0 ? 0 : (tp / (tp + fp)) * 100;
  const recall = tp + fn === 0 ? 0 : (tp / (tp + fn)) * 100;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  macroP += precision;
  macroR += recall;
  macroF += f1;
  return { label, support: tp + fn, tp, fp, fn, precision, recall, f1 };
});
macroP /= labels.length;
macroR /= labels.length;
macroF /= labels.length;

const fmt = (n: number) => n.toFixed(1);

console.log(`Split: ${split} — ${rows.length} descriptions, ${labels.length} categories`);
console.log(`Classifier: frontend/lib/classification.ts — deterministic keyword baseline`);
console.log(`Correct: ${correct}/${rows.length}   Accuracy: ${fmt(accuracy)}%`);
console.log(`Macro precision ${fmt(macroP)}%  macro recall ${fmt(macroR)}%  macro F1 ${fmt(macroF)}%\n`);
console.log('| Category | Support | TP | FP | FN | Precision | Recall | F1 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const c of perCategory) {
  console.log(`| ${c.label} | ${c.support} | ${c.tp} | ${c.fp} | ${c.fn} | ${fmt(c.precision)}% | ${fmt(c.recall)}% | ${fmt(c.f1)}% |`);
}
console.log(`| **Overall (accuracy)** | ${rows.length} | ${correct} | ${rows.length - correct} | ${rows.length - correct} | ${fmt(macroP)}% | ${fmt(macroR)}% | ${fmt(accuracy)}% |`);

const misses = rows.filter((r) => !r.correct);
console.log(`\nMisclassified (${misses.length}):`);
for (const m of misses) console.log(`  ${m.id}: expected ${m.expected}, got ${m.predicted}`);

// Sanity: the evidence-bearing variant must agree with the simple one.
const disagreement = corpus.filter((item) => {
  const a = classifyFault(item.description) || '(none)';
  const b = classifyFaultWithEvidence(item.description).category || '(none)';
  return a !== b;
}).length;
console.log(`\nclassifyFault vs classifyFaultWithEvidence disagreements: ${disagreement}`);

writeFileSync(
  resolve(here, outName),
  JSON.stringify(
    {
      split,
      corpusSize: rows.length,
      accuracy: Number(accuracy.toFixed(1)),
      macroPrecision: Number(macroP.toFixed(1)),
      macroRecall: Number(macroR.toFixed(1)),
      macroF1: Number(macroF.toFixed(1)),
      perCategory: perCategory.map((c) => ({
        ...c,
        precision: Number(c.precision.toFixed(1)),
        recall: Number(c.recall.toFixed(1)),
        f1: Number(c.f1.toFixed(1)),
      })),
      confusion,
      rows,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);
console.log('\nWrote docs/evaluation/classification-results.json');
