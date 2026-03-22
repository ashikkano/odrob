import globals from 'globals'

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'server/node_modules/**',
      'public/docs/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {},
  },
]
