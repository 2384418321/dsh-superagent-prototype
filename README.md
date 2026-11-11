# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

### DeepSeek Harness 客户端安装

在客户端“插件 → 添加插件”中输入本仓库地址并安装，启用 Superagent 后从侧栏打开面板。仓库包含已构建的插件文件，无需在目标电脑手动构建。

首次使用时在面板的“设置 → 来源”配置有权限的 GitHub 仓库及已登录的 GitHub CLI，再配置接单规则和执行目录。默认状态目录为当前用户的 `~/.dsh/state/dsh-superagent`；如需迁移现有工单，先停止原实例并配置原状态目录，不能让两个实例同时调度。

评估和执行模型默认继承当前客户端的默认模型，也可在面板分别选择客户端已有的提供商、模型和思考强度。已有会话保留自己的模型选择；更改默认值不会自动改写它们。

本插件运行在客户端宿主进程中，完成 GitHub 设置后会修改该进程的 `PATH` 和 Git 配置环境变量，影响同一客户端的其他会话；需要独立环境时使用专用 profile 或单独的系统账号。不同电脑需各自配置 GitHub 凭据、目标仓库、工作目录与模型；安装插件不会自动复制这些配置或会话数据。

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build. Commit the rebuilt `lib/` files with source changes so installing directly from Git remains usable.

## License

[MIT](LICENSE)
