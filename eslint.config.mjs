// Lint config: GJS code (GNOME extension, native host, tools) and the
// Chromium extension (browser globals, content scripts are classic scripts).

const unusedVars = ['error', {argsIgnorePattern: '^_|^[a-z]$|^(proxy|sender|menu|item|m)$'}];

const gjsGlobals = {
    global: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    console: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
};

const browserGlobals = {
    chrome: 'readonly',
    window: 'readonly',
    document: 'readonly',
    navigator: 'readonly',
    location: 'readonly',
    performance: 'readonly',
    console: 'readonly',
    fetch: 'readonly',
    FileReader: 'readonly',
    EventTarget: 'readonly',
    CustomEvent: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
};

export default [
    {
        files: ['gnome-extension/**/*.js', 'native-host/**/*.js', 'tools/**/*.js'],
        languageOptions: {ecmaVersion: 2022, sourceType: 'module', globals: gjsGlobals},
        rules: {'no-unused-vars': unusedVars, 'no-undef': 'error'},
    },
    {
        files: ['chromium-extension/**/*.js'],
        languageOptions: {ecmaVersion: 2022, sourceType: 'module', globals: browserGlobals},
        rules: {'no-unused-vars': unusedVars, 'no-undef': 'error'},
    },
    {
        files: ['chromium-extension/content/*.js'],
        languageOptions: {sourceType: 'script'},
    },
];
