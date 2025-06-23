import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
    { ignores: ['bin', 'node_modules', 'docs', '**/*.js'] },
    { files: ['**/*.{mjs,cjs,ts}'] },
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
        }
    },
    {
        rules: {
            '@typescript-eslint/no-unused-vars': 'error',
        },
    },
    pluginJs.configs.recommended,
    ...tseslint.configs.recommended,
];