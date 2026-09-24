# Fork 维护

这个 fork（hxy91819/cursor-acp，上游 raphaelluethy/cursor-acp）只服务于三件事：

1. 每个功能/修复保持为一个独立、聚焦、可以直接向上游提交的分支；
2. 本机能方便地把这些分支聚合打包；
3. 能随时纳入上游的稳定版更新。

除此之外不引入额外结构：没有领域分支、没有补丁登记表、没有冻结清单。
分支本身就是状态，`.fork/branches` 是唯一的清单。

## 仓库角色

| 引用 | 作用 |
| --- | --- |
| `origin` | 上游 raphaelluethy/cursor-acp，只读（push URL 设为 `no_push`，永远不会向上游推送） |
| `fork` | 个人 fork hxy91819/cursor-acp，所有推送都去这里 |
| `upstream-main/<日期>-<短SHA>` tag | 上游 `main` 的基线，只存在于 fork；聚合和新分支的起点 |
| `feature/*`、`fix/*` | 每个改动一个分支，基于基线 tag |
| `fork-tooling` | 维护规则、`.fork/branches`、聚合脚本、本文档；和其他分支一样被 merge |
| `local/aggregate` | 聚合产物，每次从基线 tag 重新生成并覆盖，根目录永远检出它 |

### 基线 tag 的说明

上游发 tag 的频率很低，而 `v0.9.1` 之后的 "harden cursor sdk prompt lifecycle"（`d422bdd`）正好改动了 steer 要改的代码，所以按 owner 决定跟上游 `main`：`scripts/fork-aggregate` 只接受 tag 作基线，因此给选定的上游 `main` 提交打一个 **fork 本地 tag**，命名 `upstream-main/<YYYYMMDD>-<短SHA>`，只推到 fork，并写进 `.fork/branches` 的 `base` 行。

- 这类 tag 只存在于 fork，不在上游：另一台机器必须先 `git fetch fork --tags` 才能解析 `base` 行。
- 上游发布包含当前基线的正式 tag 之后，把 `base` 改成那个正式 tag（流程见"纳入上游新版本"），tag 就回到上游默认规则。

## 1. 开发新功能或修复

从当前基线 tag 拉分支，在独立 worktree 里开发：

```bash
base=$(git show fork-tooling:.fork/branches | awk '$1=="base"{print $2}')
git fetch fork --tags
git worktree add .worktrees/<name> -b feature/<name> "$base"   # 修复用 fix/<name>
```

- 不要从 `local/aggregate` 拉分支，否则分支会带上全部聚合内容，无法单独提给上游。
- 只有真正依赖另一个 fork 分支时，才从那个分支拉出（叠放），并在清单说明里写"叠在 X 上"。
- 修改已有功能：直接在它的分支上继续提交。分支落后于基线也没关系，merge 会处理；只有冲突时才 rebase。
- 完成后：相关测试通过 → 提交 → `git push fork <branch>` 并核对远端 SHA。
- 在 `fork-tooling` 分支的 `.fork/branches` 加一行（分支、上游状态、说明），提交并推送 `fork-tooling`。

## 2. 聚合打包

```bash
scripts/fork-aggregate            # 生成 .worktrees/aggregate-next 上的 aggregate/next
scripts/fork-aggregate --promote  # 成功后移动根目录 local/aggregate 并推送到 fork
```

脚本从基线 tag 开始，依次 `merge --no-ff` 清单中的分支。每次都从头生成，没有中间状态需要维护。
在 `.worktrees/aggregate-next` 里按下面的验证命令验证，通过后再 `--promote`；各分支自己的测试在分支上已经跑过。
提升与推送到 fork 不需要再询问；替换本机运行中的服务按本项目的部署授权与流程执行。

### 验证命令

在聚合 worktree（或提升后的根目录）里依次执行：

```bash
nub install      # 安装依赖；postinstall 会给 @cursor/sdk 打署名补丁，SDK 运行时代码不匹配时安装失败
nub run check    # oxlint + oxfmt --check
nub run test:run # vitest run（一次性跑完）
nub run build    # tsc，产物到 dist/
```

需要 Node.js 22.13+（`nub` 自带 Node 供给能力）。四项全绿才算聚合可提升。

### 冲突怎么解决

脚本遇到冲突会停下，并判断是哪一类：

| 类型 | 判断 | 处理 |
| --- | --- | --- |
| 分支与上游冲突 | 该分支单独合入基线 tag 就冲突 | 在该分支 worktree 里 `git rebase --no-autostash <tag>`，修复、测试、`git push --force-with-lease fork <branch>`，重跑脚本。修好的分支同时也保持了对上游可合并。 |
| 分支之间冲突 | 单独都能合入，一起才冲突 | 在 `.worktrees/aggregate-next` 里只做两边合并、不加新行为，`git add` 后 `git commit --no-edit`，重跑脚本。`rerere` 会记住这次解决，下次自动复用。 |

- 产品修复永远回到对应分支，不写在聚合的 merge 提交里。
- 同一对分支反复出现非平凡冲突时，把后者 rebase 到前者上（叠放），更新清单顺序和说明。
- 叠放分支 rebase 时从栈底开始，用 `git rebase --update-refs` 让上层分支一起移动。

### 纳入上游新版本

1. 给选定的上游 `main` 提交打新的 `upstream-main/<日期>-<短SHA>` tag（或改用上游的正式 tag），推到 fork。
2. 把 `.fork/branches` 的 `base` 改成新 tag（或先用 `scripts/fork-aggregate --base <tag>` 试跑）。
3. 运行脚本，按上表逐个处理冲突。没有冲突的分支不用动。
4. 某个分支 rebase 后变空，说明上游已经包含它：从清单删除这一行，删除分支（fork 上的也删），在提交说明里写明被上游哪个版本吸收。
5. 验证、`--promote`，提交并推送 `fork-tooling` 上的新 `base`。

## 3. 向上游反馈

分支本身就是上游 PR 的材料，这也是分支必须保持独立、基于 tag 的原因。

1. 先在上游搜索是否已有相关 issue/PR，按本项目的 issue/PR 规范准备内容。
2. **向上游提 issue、评论或 PR 之前，必须把拟提交的内容给用户逐项确认。** 用户可以决定把它标为 `fork-only` 保留在本地。
3. 提 PR 时：从该分支 rebase 到上游 `main` 得到一个新分支（如 `upstream/<name>`）推送到 fork，再开 PR；叠放分支要先把依赖部分一并处理或拆开。
4. 在 `.fork/branches` 更新该行的状态和链接（`reported` / `pr-open` / `fork-only`）。
5. 上游合并后，等它进入一个稳定 tag 再从清单移除（见上一节第 4 步）。issue 关闭本身不是移除理由。

## 4. 部署

### 本机（/data/code/cursor-acp）

BB 通过 `customAgents` 接入聚合根目录构建出的入口，不使用全局 `npm link`——"聚合在哪、BB 用的就是哪份"一目了然。`nativeSkillRoots` 必须对齐 BB 内置 `acp-cursor` 的四族根（`recursive`，project 侧加 `ancestors`），只写 `.cursor/skills` 会让 BB 的技能自动发现扫不到东西：

```json
{
  "customAgents": [
    {
      "id": "cursor-sdk",
      "displayName": "Cursor (SDK)",
      "command": "node",
      "args": ["/data/code/cursor-acp/dist/index.js"],
      "steeringMode": "auto",
      "nativeSkillRoots": {
        "user": [
          {"path": ".cursor/skills", "recursive": true},
          {"path": ".agents/skills", "recursive": true},
          {"path": ".claude/skills", "recursive": true, "skipIfManifest": ".claude-plugin/plugin.json"},
          {"path": ".codex/skills", "recursive": true}
        ],
        "project": [
          {"path": ".cursor/skills", "recursive": true, "ancestors": true},
          {"path": ".agents/skills", "recursive": true, "ancestors": true},
          {"path": ".claude/skills", "recursive": true, "ancestors": true, "skipIfManifest": ".claude-plugin/plugin.json"},
          {"path": ".codex/skills", "recursive": true, "ancestors": true}
        ]
      }
    }
  ]
}
```

- 重新聚合（`--promote`）后必须再跑一次 `nub install && nub run build`，BB 才会用上新版本；BB 设置变更即时生效，不需要重启。
- 原 `acp-cursor`（`cursor-agent acp`）保持不变，两者并存。
- SDK 凭据不写进 `customAgents.env`：在 host 上用 `cursor-acp login` 或持久的 `CURSOR_API_KEY` 提供。

### 另一台机器

```bash
# 1. 拉取：fork 为 origin 之外的推送目标，基线 tag 与聚合分支都来自 fork
git clone https://github.com/hxy91819/cursor-acp.git /data/code/cursor-acp
cd /data/code/cursor-acp
git remote rename origin fork                  # clone 出来的 origin 就是 fork
git remote add origin https://github.com/raphaelluethy/cursor-acp.git
git remote set-url --push origin no_push       # 上游只读
git fetch --tags fork                          # 基线 tag 只存在于 fork
git fetch fork local/aggregate
git checkout -B local/aggregate fork/local/aggregate   # 根目录永远检出 local/aggregate

# 2. 安装并构建（Node 22.13+；nub 未安装时 npm install -g @nubjs/nub）
nub install
nub run build

# 3. SDK 登录（浏览器完成）；或用持久环境变量 export CURSOR_API_KEY=...
./node_modules/.bin/cursor-acp login   # 或 node dist/index.js login
# 凭据落在 ~/.cursor/sdk/auth.json，与 cursor-agent login 相互独立

# 4. BB 配置：customAgents 一项指向上一步构建出的入口绝对路径（见上一节 JSON）
#    设置保存后该 provider 立即出现在 BB 的 provider 列表

# 5. 可选自检：按本节"验证命令"跑一遍，确认拉取到的聚合可复现
nub run check && nub run test:run
```

要在这台机器上继续开发，按第 1 节从 `base` tag 拉分支建 worktree；要重新聚合，按第 2 节运行 `scripts/fork-aggregate`（清单读自 `fork-tooling`）。
