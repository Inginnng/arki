# 快速开始

Arki 把项目的实现整理成架构文档、组件图和典型流程。它需要本地 Node.js，以及已经登录且可运行的 Codex。AI 请求会使用你的 Codex 服务与额度。

## 方式一：让 AI 帮你安装（推荐）

将下面这句话复制给能操作本机终端的 AI 助手（例如 Codex）：

```text
https://github.com/Inginnng/arki，帮我安装 Arki。
```

想指定要分析的项目，再补充项目目录即可。让 AI 参照本仓库的安装说明检查环境、完成安装并打开工作台；需要账号登录时，由你完成登录。

也可以按下面的步骤手动安装。

## 环境

- 建议 Node.js 22 LTS；最低 20.19。
- 可执行的 Codex CLI，已完成登录；`codex --version` 可用。部分 Codex Desktop 安装会附带 CLI。
- 从源码构建需要 pnpm 10.33、Git 和 ripgrep。下载发行包无需安装项目依赖。
- Windows + Edge 是当前主要实测环境；macOS/Linux 的完整 Codex 联调仍待验证。

## 方式二：下载发行包

从 [Releases](https://github.com/Inginnng/arki/releases) 下载 `arki-<version>.zip` 和 `SHA256SUMS.txt`。Windows 可用 `Get-FileHash` 核对 ZIP 的 SHA-256，再解压到独立目录。

在解压后的 `arki-<version>` 目录运行：

```sh
node dist/arki.mjs --root "你的项目目录" --open
```

Windows 也可将项目文件夹拖到发行包内的 `Arki.cmd`。目录参数是**要分析的项目**，不是 Arki 安装目录。启动器会输出本地地址，复用对应项目的后台或选择空闲端口。

## 方式三：从源码运行

```sh
git clone https://github.com/Inginnng/arki.git
cd arki
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开输出的本地地址。分析另一个项目时运行：

```sh
node scripts/arki.mjs --root "你的项目目录" --open
```

## 方式四：在 Codex 中使用插件

在支持 `codex plugin` 的版本中，克隆仓库后注册本地 marketplace：

```sh
codex plugin marketplace add .
codex plugin add aimd-reader@aimd-local
```

之后重启 Codex 或打开新任务，输入：**用 Arki 分析当前项目架构**。插件内部 ID 保留 `aimd-reader`，产品名称为 Arki · 一览。插件能力依赖宿主版本；如果当前 CLI 没有 `plugin` 子命令，先用独立工作台方式。

插件机制见 [OpenAI 官方文档](https://developers.openai.com/plugins)。上述本地注册命令按当前 Codex CLI 的帮助输出核对；不同版本的界面可能变化。

## 第一次分析

1. 在工作台点击「一键分析当前项目」，或进入架构工作台。
2. 等待 AI 阅读实现并组织分析；大型项目可能需要数分钟。
3. 在「架构分析图」查看职责和归属，在「流程图」选择典型场景。
4. 点击组件、流程步骤或连线追问，再打开代码来源核对。
5. 使用「导出 MD / HTML」保留可分享的分析。

重新打开时使用相同浏览器和地址。「继续上次分析」会恢复已保存的图与问答；浏览器数据清理、不同端口和不同浏览器会影响存档可见性。详见 [使用指南](user-guide.md) 和 [常见问题](troubleshooting.md)。
