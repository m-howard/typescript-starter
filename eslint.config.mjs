import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.COnfig[]} */
export default [
    { ignores: ['bin', 'node_modules', 'docs', '**/*.js'] },
    { files: ['**/*.{mjs,cjs,ts}'], },
    {
        languageOptions: {
            globals: {
                globals: {...globals.node },
            },
        }
    },
    {
        rules: {
            'no-unused-vars': 'error',
        },
    },
    pluginJs.configs.recommended,
    ...tseslint.configs.recommended,
];