# Input Kanban

中文 | [English](README.en.md)

冠名支持：<a href="https://ai.input.im"><img src="public/assets/ai-input-logo.png" alt="AI.INPUT.IM" width="18" align="absmiddle" /></a> [AI.INPUT.IM](https://ai.input.im) —— 只用一个 API 调用所有模型，专为开发者打造的 AI API 网关。

你可以把 Input Kanban 当成一个本地 Codex 执行看板：先把任务放进来，再让它自动拆分、派发、执行和验收。下面重点讲**怎么用**，不是讲内部实现。

## 最快开始

### 1. 安装

```bash
npm install -g input-kanban
```

确认可用：

```bash
input-kanban --help
```

### 2. 进入目标工作区

在你要让 Codex 修改或检查的目录里启动：

```bash
cd /path/to/your/workspace
input-kanban
```

默认会启动本地服务：

```text
http://127.0.0.1:8787
```

打开浏览器后，你就可以直接创建任务批次、看执行状态、看结果。

### 3. 不想先 `cd`？直接指定工作区

```bash
input-kanban --workspace /path/to/your/workspace
```

`--repo` 也可以继续用，作为兼容别名。

## 最常见的 6 个用法

### 1) 在网页里新建并自动执行

1. 点击 `新建任务批次`
2. 填好工作区、Worker 沙箱和任务说明
3. `跳过 Codex Git/信任目录检查` 默认勾选；如果不是可信 umbrella / 非 Git 根目录，可取消勾选
4. 点击 `创建批次`
5. 看板会自动发起 `拆分任务`
6. 拆分完成后自动派发 worker
7. 所有批次完成后自动发起最终验收

### 2) 从终端直接提交一个任务

```bash
input-kanban submit --task "修复登录问题，并补充回归测试" --label "修复登录问题"
```

如果你想从文件读任务：

```bash
input-kanban submit --task-file task.md
```

如果目标是可信的 umbrella / 非 Git 工作区，可显式传给 Codex：

```bash
input-kanban submit --task-file task.md --codex-skip-git-repo-check
```

### 3) 先看计划，再决定是否执行

```bash
input-kanban submit --task-file task.md --plan-approval
```

这会在规划完成后停在“已拆分，待确认”，等你在 Web 上点 `开始执行` 再继续。

### 4) 只想创建并规划，不马上派发

```bash
input-kanban submit --task-file task.md --no-auto
```

### 5) 查看进度 / 结果 / 重试 / 停止

```bash
input-kanban status <runId>          # 默认读取快照，不抢状态锁
input-kanban status <runId> --watch  # 默认轮询快照
input-kanban status <runId> --refresh # 显式同步 runner 状态
input-kanban result <runId>
input-kanban result <runId> --copy
input-kanban job <runId> <taskId|planner|judge> # 查看 standalone 任务包、产物清单和 Job 事件
input-kanban retry <runId> [taskId]
input-kanban stop <runId>
```

## Agent 与任务交接工作流

### CLI-only Agents

如果你是只会调用 CLI 的 Agent，直接运行：

```bash
input-kanban guide
```

或者：

```bash
input-kanban --help
```

`guide` 会输出一个更适合 Agent 的操作循环和可直接复制的示例模板。

### 安装内置 Codex skills

如果你想把内置 skills 安装到 Codex：

```bash
input-kanban install-skill codex
```

这会安装：

- `input-kanban-prepare`：把外部 Agent 对话整理成可执行的 `task.md`，用于提交看板或直接执行。
- `input-kanban-execute`：读取这种 `task.md`，在当前单个 Agent 对话里直接完成任务，不提交到看板。

如需指定 Codex skills 根目录：

```bash
input-kanban install-skill codex --target-dir ~/.codex/skills
```

### 外部 Agent 对话交给看板执行

如果任务先在 Claude、Cursor、Codex 或其它外部 Agent 对话里讨论，建议先整理成结构化 `task.md`，再交给 Input Kanban。建议把草稿放到 `.tmp/input-kanban/`，并用 `YYYYMMDD-HHmm-<short-slug>-task.md` 命名，方便排序和避免覆盖：

```text
.tmp/input-kanban/20260601-1909-p0-precompute-input-copy-boundary-task.md
```

```bash
input-kanban submit --task-file task.md --plan-approval
```

推荐 `task.md` 至少包含：

- `Goal`：这次要完成什么
- `Acceptance Criteria`：怎么判断完成
- `Expected Artifacts`：期望产物和验证方式
- `Context References`：相关文件、spec、历史记录
- `Risks`：风险、假设和不确定点

可以参考 `skills/input-kanban-prepare/SKILL.md` 或 `docs/input-kanban-prepare.md`。这样 planner 会拿到更稳定的执行契约，而不是从一段模糊需求里从零猜。

### 使用当前对话直接执行已准备任务

如果任务较小，不需要看板、多 worker、批次调度或最终 judge，可以用 `input-kanban-execute` 在当前对话里直接执行 prepare 生成的 `task.md`：

```text
use input-kanban-execute skill on .tmp/input-kanban/20260601-1909-example-task.md and complete it in this conversation
```

这种方式不会创建 Input Kanban run；它适合单线程小/中型任务。复杂任务仍建议使用 `input-kanban submit --task-file ... --plan-approval`。详见 `skills/input-kanban-execute/SKILL.md` 和 `docs/input-kanban-execute.md`。

## 常用命令速查

```bash
input-kanban submit --task "..."
input-kanban submit --task-file task.md
input-kanban submit --task-file task.md --plan-approval
input-kanban submit --task-file task.md -d
input-kanban install-skill codex
input-kanban deps tmux
input-kanban --json runs --active
input-kanban --json status <runId>
input-kanban --json result <runId>
input-kanban --json job <runId> <taskId|planner|judge>
input-kanban --json retry <runId> [taskId]
input-kanban --json stop <runId>
```

如果你需要让脚本或其它工具接管，`--json` 会给出结构化输出。

## tmux 模式（可选）

默认 runner 是 `headless`。如果你想在终端里实时看每个角色怎么跑，可以切到 `tmux`：

```bash
input-kanban submit --task-file task.md --runner tmux
```

tmux 模式适合：

- 想看 planner / worker / judge 的实时终端输出
- 想在 batch window 里同时看 overview pane 和 worker panes
- 想在本地排查执行过程

如果你不需要终端可视化，就继续用默认的 `headless`。

Web 新建任务批次时也可以选择 runner：

- `跟随默认`：使用本机配置里的默认 runner
- `headless`：当前批次强制使用 headless
- `tmux`：当前批次强制使用 tmux

默认 runner 会保存到本机配置文件 `~/.input-kanban/config.json`，CLI 和 Web 共用；如果设置了环境变量 `KANBAN_RUNNER`，环境变量优先。

Windows 下 `headless` 仍是默认且不依赖 Git Bash 或 tmux。只有选择 `tmux` runner 时才会检查 tmux 和自动 shell 后端；Windows 会优先使用 PowerShell，不可用时回退到 `cmd`，非 Windows 会使用 `bash`/`sh`。Web、CLI 和环境页不再提供 Git Bash / WSL 等 shell 选项。

如果 Web 里选择 `tmux` 但本机没有检测到 tmux，会禁止创建批次并提示安装命令。Web 不会直接安装系统依赖；需要在终端里显式执行：

```bash
input-kanban deps install tmux
```

安装命令会按平台选择常见包管理器，例如 Windows 的 winget/psmux、macOS 的 Homebrew、Linux 的 apt/dnf/pacman/zypper/apk。Windows 上的 psmux 是第三方 tmux 兼容实现；也可以自行安装其他实现，只要当前环境里有可用的 `tmux` 命令即可。执行安装前会展示将运行的命令并要求确认；也可以先查看计划：

```bash
input-kanban deps install tmux --dry-run
```

## 数据会存到哪里

默认运行数据目录是：

```text
~/.input-kanban/runs
```

每个 run 大致会长这样：

```text
runs/<runId>/
├── task.md
├── plan.json
├── run_state.json
├── planner/
├── workers/<taskId>/
└── judge/
    ├── judge_input.json
    └── verdict.json
```

这些都是本地运行记录，不需要提交到你的业务仓库。

## Standalone 任务包

从 v0.0.32 开始，Input Kanban 会为本地 standalone 执行写入标准任务包。它不会改变旧的 `prompt.md`、`events.jsonl`、`last_message.md`、`result.json`、`verdict.json` 等路径；新文件只是额外放在每个角色目录的 `package/` 下：

```text
planner/package/job.json
workers/<taskId>/package/job.json
judge/package/job.json
```

同一目录还会包含：

- `prompt.md`：这次实际交给 agent 的 prompt 副本
- `workspace.json`：本地工作区和 Git 元数据
- `execution.json`：runner、agent runtime、sandbox 等执行信息
- `artifacts.json`：标准产物契约
- `manifest.json`：产物是否存在、大小和修改时间
- `job_events.jsonl`：`job.packaged`、`job.started`、`job.completed`、`job.failed` 等生命周期事件

你可以在 Web 任务详情里查看 `任务包`、`产物清单` 和 `Job事件`；旧 run 没有这些文件时不会显示对应 tab。CLI 也可以只读查看：

```bash
input-kanban job <runId> T-01
input-kanban --json job <runId> T-01
```

这套 standalone contract 是本地执行的可审计记录；distributed worker、远程执行和 replay 仍是后续能力，不属于 v0.0.32。

## 你通常会怎么用它

- 把一个较大的 Codex 编程任务拆成多个执行步骤
- 在 Web 里看计划、执行、结果
- 在终端里自动提交、查看、重试、停止
- 在需要时用 `plan-approval` 增加一个人工确认关口
- 在需要终端细节时用 `tmux` 看实时过程

## 使用前提

- Node.js 20 或更高版本
- 已安装并可用的 Codex CLI
- 如果要用 `--runner tmux`，本机需要安装 `tmux`
- 可用 `input-kanban deps tmux` 检查 tmux 状态
- `codex` 命令在终端可用，或通过 `--codex-bin` 指定可执行文件

## 维护者开发

如果你要开发 Input Kanban 本身：

```bash
git clone https://github.com/zhang3xing1/Input-Kanban.git
cd Input-Kanban
npm install
npm start
```

本地 CLI 开发：

```bash
npm link
input-kanban --help
```

检查：

```bash
npm run check
```

## 更多文档

- [项目实现说明](docs/PROJECT_GUIDE.md)
- [环境变量](ENVIRONMENT.md)
- [Agent CLI 说明](docs/input-kanban-cli-README.md)
- [Agent CLI Skill 草稿](docs/input-kanban-cli-skill.md)
- [结构化任务交接指南](docs/input-kanban-prepare.md)
- [直接执行已准备任务](docs/input-kanban-execute.md)
- [input-kanban-prepare Skill](skills/input-kanban-prepare/SKILL.md)
- [input-kanban-execute Skill](skills/input-kanban-execute/SKILL.md)
