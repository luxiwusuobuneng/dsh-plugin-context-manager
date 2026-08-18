# Third-Party Notices

`dsh-context-manager` is licensed under the [MIT License](LICENSE).
It imports the third-party software listed below. Each project remains
under its own license; nothing in this file changes those terms.

All listed packages are **MIT-licensed**. The MIT License requires that any
copy or substantial portion of the software include the original copyright
notice and permission notice. The upstream copyright lines are reproduced
here; the full MIT text is available in each package's own `LICENSE` file
and at <https://opensource.org/license/mit>.

## Runtime dependencies

| Package | Copyright / License | Source |
| --- | --- | --- |
| `@deepseek-ai/cordis` | Copyright (c) the Cordis contributors — MIT | <https://github.com/cordiverse/cordis> |
| `@deepseek-ai/schemastery` | Copyright (c) the Schemastery contributors — MIT | <https://github.com/deepseek-harness/schemastery> |
| `@deepseek-ai/dsh-compaction` | Copyright (c) DeepSeek Harness contributors — MIT | <https://github.com/deepseek-harness/deepseek-harness> |
| `@deepseek-ai/dsh-compaction-basic` | Copyright (c) DeepSeek Harness contributors — MIT | <https://github.com/deepseek-harness/deepseek-harness> |
| `@deepseek-ai/dsh-storage-domain` | Copyright (c) DeepSeek Harness contributors — MIT | <https://github.com/deepseek-harness/deepseek-harness> |
| `@deepseek-ai/dsh-typert-protocol` | Copyright (c) DeepSeek Harness contributors — MIT | <https://github.com/deepseek-harness/deepseek-harness> |
| `@deepseek-ai/dsh-llm` | Copyright (c) DeepSeek Harness contributors — MIT | <https://github.com/deepseek-harness/deepseek-harness> |
| `@deepseek-ai/dsh-session` | Copyright (c) DeepSeek Harness contributors — MIT | <https://github.com/deepseek-harness/deepseek-harness> |
| `zod` | Copyright (c) Colin McDonnell — MIT | <https://github.com/colinhacks/zod> |

## Notes

- This plugin is an **add-on** for DeepSeek Harness. DeepSeek Harness itself
  is MIT-licensed; its own full dependency declaration lives in its
  `THIRD-PARTY-NOTICES.md` (see the upstream repository).
- This repository does **not** vendor or redistribute the dependencies
  listed above. At install time they are resolved from npm (or provided by
  an existing DeepSeek Harness installation), so their license texts ship
  inside each installed package as usual.
- `@deepseek-ai/*` packages are first-party publications of the DeepSeek
  Harness project, listed here only for completeness of attribution.
