# Repository Guidelines

## Project Structure & Module Organization
Source lives in `src/`. Key modules include the outer ACP agent (`src/cursor-acp-agent.ts`), the prompt-runner interface (`src/cursor-runner.ts`), the Cursor SDK backend (`src/cursor-sdk-runner.ts`), first-turn user rules and supplemental skill context (`src/session-context.ts`), skill discovery (`src/skills.ts`), SDK event conversion (`src/cursor-sdk-event-adapter.ts`), model-id mapping (`src/model-id.ts`), and prompt conversion (`src/prompt-conversion.ts`). Production prompt execution uses `@cursor/sdk`; the adapter adds session persistence, history replay, model and mode controls, and ACP permission fallback behavior. The thinking selector maps SDK `thinking`, `reasoning`, or `effort` parameters while preserving the catalog id. The native ACP and legacy CLI runners remain compatibility surfaces, not the default prompt backend. Tests are in `src/tests/` and use the `.test.ts` naming pattern. Build output is emitted to `dist/` and should not be edited by hand. Documentation and notes live in `docs/`.

## Build, Test, and Development Commands
- `nub install`: install dependencies. A postinstall script patches the pinned `@cursor/sdk` so global CLI attribution settings are honored; install fails if that runtime code no longer matches.
- `nub run build`: compile TypeScript to `dist/` via `tsc`.
- `nub run start`: run the built CLI from `dist/index.js`.
- `nub run dev`: build then start (handy for local iteration).
- `nub run lint` / `nub run lint:fix`: run Oxlint on `src/` (with or without auto-fix).
- `nub run format` / `nub run format:check`: format or verify formatting with `oxfmt`.
- `nub run check`: lint + format check (CI-friendly).
- `nub run test`: Vitest in watch mode.
- `nub run test:run`: one-shot test run.
- `nub run test:coverage`: one-shot run with coverage.

## Coding Style & Naming Conventions
This is an ESM TypeScript project. Follow existing patterns in `src/`: kebab-case filenames (for example `cursor-event-mapper.ts`), `camelCase` for variables/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Use `oxlint` and `oxfmt` as the primary style and formatting tools; ESLint/Prettier scripts exist for legacy checks.

## Testing Guidelines
Use Vitest and place new tests in `src/tests/` with a `.test.ts` suffix. Prefer focused unit tests for protocol mapping, SDK runner behavior, event conversion, and prompt conversion. Add or update tests alongside behavioral changes and run `nub run test:run` before opening a PR.

## Commit & Pull Request Guidelines
Commit messages generally follow Conventional Commits: `type: summary` (examples: `feat: ...`, `docs: ...`, `chore: ...`, `test: ...`). Keep the subject short and imperative. PRs should include a clear description, linked issues if applicable, and explicit test steps. Add screenshots or logs for user-facing or CLI output changes, and update `README.md` when the usage surface changes.

## Configuration & Requirements
Development expects Node.js 22.13+ and Nub. Authenticate the Cursor SDK with `cursor-acp login` or `CURSOR_API_KEY` before starting an ACP session. The Cursor CLI is needed only when explicitly exercising the legacy CLI runner or native ACP bridge.

<!-- fork-maintenance:start -->
## Fork 维护

本仓库是个人 fork（远端 `fork`，上游 `origin` = raphaelluethy/cursor-acp，只读）。目标只有三个：每个改动是独立、可直接提给上游的分支；方便本机聚合打包；能纳入上游稳定版。完整流程见 [docs/fork-maintenance.md](docs/fork-maintenance.md)，不要引入领域分支、补丁登记表或冻结清单。

- 根目录永远检出 `local/aggregate`：它是 `scripts/fork-aggregate` 每次从基线 tag 重新生成的产物。不在这里写产品代码，不从它拉分支，不从它提上游 PR。
- 基线是 fork 本地 tag `upstream-main/<日期>-<短SHA>`（owner 选择跟上游 `main`），写在 `.fork/branches` 的 `base` 行；另一台机器需先 `git fetch --tags fork`。上游发布包含当前基线的正式 tag 后可改回正式 tag。
- 新功能/修复：从 `base` tag 拉 `feature/<name>` 或 `fix/<name>`，放在 `.worktrees/<name>`；只有依赖另一 fork 分支时才叠在它上面。完成后推送到 `fork`，并在 `fork-tooling` 分支的 `.fork/branches` 登记一行。
- 聚合打包：`scripts/fork-aggregate [--promote]`；验证命令为 `nub install`、`nub run check`、`nub run test:run`、`nub run build`。分支与上游冲突 → 回该分支 rebase 修复；分支之间冲突 → 在聚合 worktree 里只合并两边，rerere 记住。产品修复不写进聚合的 merge 提交。
- 部署：BB 的 `customAgents` 指向聚合根目录构建出的入口绝对路径（`/data/code/cursor-acp/dist/index.js`）；重新聚合并构建后新会话自动用新版本。另一台机器的完整步骤见文档第 4 节。
- 环境发现：全局提示词与技能必须进入 Cursor SDK 会话中的模型上下文；目录配置、分工和验证方法见 [docs/environment-discovery.md](docs/environment-discovery.md)。
- 上游反馈：分支就是 PR 材料；向上游提 issue/评论/PR 前必须经用户逐项确认，状态记在 `.fork/branches`。
<!-- fork-maintenance:end -->
