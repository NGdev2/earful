// Lint config for GNOME Shell extension code (GJS, ES modules).
export default [
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                global: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                console: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_|^[a-z]$|^(proxy|sender|menu|item|m)$'}],
            'no-undef': 'error',
        },
    },
];
