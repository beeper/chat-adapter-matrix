import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAnyKeyword",
          message:
            "Do not assert to `any`. Prefer inference, `unknown`, or a narrower type.",
        },
        {
          selector: "TSTypeAssertion > TSAnyKeyword",
          message:
            "Do not assert to `any`. Prefer inference, `unknown`, or a narrower type.",
        },
      ],
    },
  }
);
