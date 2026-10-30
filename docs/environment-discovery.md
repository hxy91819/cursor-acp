# Cursor SDK 环境发现

目录：

1. [原则](#原则)
2. [当前全局提示词方案](#当前全局提示词方案)
3. [分工与当前配置](#分工与当前配置)
4. [验证方法](#验证方法)
5. [已知 SDK 缺陷与根因](#已知-sdk-缺陷与根因)

## 原则

全局提示词和技能属于基础环境。完成标准是它们真正进入 Cursor SDK 会话里的模型上下文；BB 的 `/` 菜单能显示技能，只证明菜单扫描成功。

所有已加载技能都能用 `/name` 手动调用。只有未设置 `disable-model-invocation: true` 的技能才进入给模型自动发现的补充清单。软链接是正常的组织方式：BB 菜单、cursor-acp 技能加载和全局规则读取都要跟随软链接。

这里的 BB `nativeSkillRoots` 用于 `/` 菜单发现，不能代替 cursor-acp 把规则和技能提供给 SDK 模型。BB 声明的有效技能根应与 cursor-acp 实际加载的根一致；增删目录时同时核对两边。Cursor SDK 没有公开的技能列表接口，不会替适配器展开 `/name` 文本，当前还会漏掉软链接技能。cursor-acp 继续保留自身的加载与调用路径，补齐 SDK 当前的缺口；SDK 修复后再评估精简。

## 当前全局提示词方案

2026-09-28 确认：对当前固定的 Cursor SDK 1.0.32，保留 cursor-acp 的首轮全局提示词注入，作为目前已验证、最适合本项目的兼容方案。暂不为此修改 SDK，也不以项目软链替换注入。

规则正文通过软链维护单一事实源：本机 `~/.agents/AGENTS.md` 指向 `mason-skills/config/user-agents.md`。`src/session-context.ts` 跟随软链读取正文、去除 frontmatter，由适配器放进新 SDK agent 的第一条用户消息；同一 SDK 会话后续轮次不重复注入，恢复会话沿用历史。它属于会话消息上下文，并非 SDK 的原生全局规则或系统提示词。规则正文更新后，需要新建 SDK 会话才能使用更新后的注入内容。

保留该方案的原因是 SDK 不原生发现上述本机全局规则文件，而项目规则指向 workspace 外文件的软链也会被 SDK 过滤；`systemPrompt` 则会完整替换内置提示词，不适合追加用户规则。软链负责正文维护，适配器负责将正文送入模型，两者继续配合使用。

验证边界：以上结论针对本机文件入口与 SDK 1.0.32；本次没有验证 Cursor 账号侧 User Rules 是否生效，不能据此声称 SDK 不读取任何形式的全局规则。SDK 升级后，只有确认原生入口能读取共享正文、跟随外部软链，并在没有适配器注入的真实调用中生效，才重新评估移除兼容逻辑。

## 分工与当前配置

| 改动 | 位置 |
| --- | --- |
| `/` 菜单能选到软链接技能 | BB 的 `customAgents` 中 Cursor (SDK) 的 `nativeSkillRoots` |
| 软链接加载、目录错误隔离、多行 description、遍历边界、项目技能查至 Git 根 | cursor-acp 的 `src/skills.ts` |
| `/name 要求` 保留用户要求并带上技能文件路径、目录 | cursor-acp 的斜杠命令展开 |
| 全局提示词进入模型上下文 | cursor-acp 首轮 SDK 消息，从 `~/.agents/AGENTS.md` 跟随软链接读取 |
| 补充可自动发现技能，排除 `disable-model-invocation: true` | cursor-acp 首轮 SDK 消息中的额外技能清单 |
| 用户级规则目录不被读取、漏掉软链接技能等 SDK 行为 | Cursor SDK；在本 fork 记录现象，由 cursor-acp 补齐 |

本机 BB 的 Cursor (SDK) 使用聚合根目录的 `dist/index.js`。技能菜单根如下；用户根不使用 `recursive`，因为 BB 递归扫描会跳过软链接技能目录，而非递归用户根会跟随它们。`.system` 单独列出，项目根保留向父目录查找：

```json
"nativeSkillRoots": {
  "user": [".agents/skills", ".agents/skills/.system", ".cursor/skills-cursor"],
  "project": [{"path": ".agents/skills", "ancestors": true}]
}
```

cursor-acp 还加载存在的 `~/.cursor/skills` 与项目 `.cursor/skills`。本机这些根当前没有要展示的技能；若启用它们，应同步核对 BB 菜单根。SDK 本地设置来源使用 `user` 与 `project`，因此真实项目技能和项目规则可由 SDK 原生加载。

BB 对不存在的技能根可能只给出空菜单，不另报配置错误。Tools → Skills 面板还会按扫描文件路径跨 provider 去重，先登记的 provider 可能取得共享技能的面板归属；应以目标 provider 的 `/` 菜单和模型真调用分别验证发现与加载。

## 验证方法

1. 在 BB 网页的 Cursor (SDK) 会话输入 `/`，确认能选到 `tdd`、`research`、`code-review`、`wizard` 和 `ppt-visual-review`。这一步只检查菜单；`ppt-visual-review` 设有 `disable-model-invocation: true`，仍应能手动选择。
2. 用 `bb status` 取得项目 ID，统计该 provider 的菜单技能：

   ```bash
   bb project commands <project-id> --provider acp-cursor-sdk --json |
     python3 -c 'import json,sys; commands=json.load(sys.stdin)["commands"]; print(sum(item["source"]=="skill" for item in commands))'
   ```

   菜单还包含 BB 插件自带的技能（条目带非空 `pluginId`，如 `automations`、`thread-list`），它们由 BB 提供，不经 cursor-acp，所以菜单总数会多于第 5 步的适配器数量。两边按技能名比较：适配器加载的每个技能都应出现在菜单里，菜单多出的只能是带 `pluginId` 的条目。

3. 在 BB 的 Cursor (SDK) 上固定 `composer-2.5`，发最短真调用：`不读文件。按你已收到的全局规则，用户引用的技能不在技能列表时，依次查哪两个目录？只回复路径。` 期望依次得到 `~/.agents/skills/<name>/` 和当前仓库 `.agents/skills/<name>/`。
4. 再发：`不读文件。仅根据你收到的额外自动发现技能清单，回复 tdd 的 SKILL.md 绝对路径；再写 ppt-visual-review 是否在这份清单中。` 期望有 `tdd` 的真实绝对路径，且 `ppt-visual-review` 没有清单条目。判断自动发现时只问允许自动发现的技能；不能用模型是否“看见”禁用自动调用的技能来判定故障。
5. 离线检查适配器实际加载的技能。数量应与去重后的有效技能目录对应，且包含软链接目标：

   ```bash
   node --input-type=module -e 'import {loadCustomSkills} from "/data/code/cursor-acp/dist/skills.js"; const skills=await loadCustomSkills("/data/code"); console.log(skills.length, skills.find(skill=>skill.name==="ppt-visual-review")?.sourcePath)'
   ```

## 已知 SDK 缺陷与根因

- SDK 的 `settingSources: ["user"]` 不会把 `~/.cursor/rules` 当作独立的用户规则目录，也不原生加载 `~/.agents/AGENTS.md`。即使加入 `project` 来源，放在该用户目录的真实 `.mdc` 文件也不会进入本项目会话；因此本机软链接链条不是这项缺失的主因。账号侧 User Rules 是否生效不在本次已验证范围内。cursor-acp 按上述方案读取并注入共享正文。SDK 1.0.32 虽有 `systemPrompt` 选项，但它会替换整个内置提示词（包括工具使用约定），且受服务端权限限制、resume 时须重传，不适合追加用户规则。
- `project` 来源决定真实项目规则与项目技能能否进入 SDK：只启用 `user` 时，真实项目探针不可见；同时启用 `user`、`project` 时可见。cursor-acp 因此启用两者。
- SDK 自身的 agent skills 列表会漏掉软链接技能。cursor-acp 只补充经过软链接发现、允许自动调用的技能，并排除与实体技能真实路径或名称重复的项；模型匹配任务时再读取对应 `SKILL.md`。SDK 没有公开的完整技能列表接口，因此适配器不能直接从 SDK 取名单做差集。
- SDK 不解释发往它的 `/name 要求` 文本；cursor-acp 在调用前展开已加载技能，附上文件与目录路径并保留要求。

### SDK 1.0.32 规则软链复核（2026-09-28）

源码与直接 SDK 调用确认，规则发现和规则最终进入模型是两个阶段：

1. `LocalCursorRulesService.loadRulesFromDirAndAncestors` 从工作目录向上查找 `AGENTS.md`、`.cursor/rules/*.mdc` 等文件；`loadRulesFromDirectory` 使用 `followSymlinks: true`。这不等于独立扫描 home 下的全局规则目录。
2. SDK local extensibility adapter 对规则 `fullPath` 和 workspace roots 调用 `realpath`，只保留真实路径位于允许 workspace roots 内的规则。祖先目录发现的规则、以及指向 workspace 外部的软链，不能仅凭扫描日志判断已经加载。
3. 对两个隔离目录直接使用 `Agent.create({ model: { id: "composer-2.5" }, tools: [], local: { cwd, settingSources: ["user", "project"] } })`，没有经过 cursor-acp，也没有首轮补充上下文。项目内真实 `.cursor/rules/probe.mdc` 含 `alwaysApply: true` 和随机探针值；另一个项目的同名入口软链到项目外的同内容文件。两个调用日志都是 `ruleCount: 1`，但只有项目内真实文件的会话能回答探针值，外部软链的会话回答 `MISSING`。探针值未写进用户问题。

因此，不能通过在每个项目建立 `.cursor/rules/user-agents.mdc -> ~/.agents/AGENTS.md` 就移除当前注入。共享规则正文仍应通过 `~/.agents/AGENTS.md` 指向唯一事实源维护；要改用 SDK 原生规则上下文，须先解决用户级规则入口与外部软链过滤这两个问题，再验证并移除首轮注入。不要把共享目录加入 `local.dirs` 作为默认修复，这会把配置目录也变成模型的工作区。

`systemPrompt` 是完整替换而非追加规则，见 [Cursor SDK 官方文档](https://cursor.com/docs/sdk/typescript#replacing-the-system-prompt)。它不能直接代替用户规则接入。
