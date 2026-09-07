// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/*.d.ts',
      'docs/**',
      'supabase/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Masterplan 85: no secrets in NEXT_PUBLIC_*, no service-role key in client code.
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/SERVICE_ROLE/]",
          message:
            'Service-role credentials must be resolved through the SecretProvider on the server only.',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
);
