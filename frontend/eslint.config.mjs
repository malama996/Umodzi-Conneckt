import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import prettier from 'eslint-config-prettier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  prettier,
  {
    // Bullet 2: enforce the canonical category system (lib/categories.ts).
    // Legacy category names must not reappear in functional code.
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value='Mechanics']",
          message:
            "Legacy category 'Mechanics' was renamed to 'Automotive'. Use technicianCategories from lib/categories.ts.",
        },
        {
          selector: "Literal[value='ICT support']",
          message:
            "Legacy category 'ICT support' was renamed to 'ICT'. Use technicianCategories from lib/categories.ts.",
        },
        {
          selector: "Literal[value='Appliance repair']",
          message:
            "Legacy category 'Appliance repair' was renamed to 'Appliance Repair'. Use technicianCategories from lib/categories.ts.",
        },
      ],
    },
  },
];

export default config;
