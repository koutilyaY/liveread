import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import next from "@next/eslint-plugin-next";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": next,
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        sessionStorage: "readonly",
        localStorage: "readonly",
        performance: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        WebSocket: "readonly",
        AudioContext: "readonly",
        AudioWorkletNode: "readonly",
        MediaRecorder: "readonly",
        MediaStream: "readonly",
        MediaDevices: "readonly",
        DOMException: "readonly",
        Blob: "readonly",
        URL: "readonly",
        btoa: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        console: "readonly",
        process: "readonly",
        React: "readonly",
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...next.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
