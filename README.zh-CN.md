<div align="center"><a name="readme-top"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
  <img alt="webapp-anything：把任何桌面程序变成一个能在浏览器里运行的链接" src=".github/assets/banner-light.svg" width="100%">
</picture>

### 把桌面软件变成网页版，一条命令发布。

DOS / Windows 程序 · Java 应用 · Flash 动画 · Linux 程序 · 可启动磁盘镜像

[English](README.md) · **简体中文** · [快速开始](#-快速开始) · [支持哪些程序](#-支持哪些程序) · [自建服务器](#-自建发布服务器) · [文档](docs/architecture.md)

[![][ci-shield]][ci-link]
[![][license-shield]][license-link]
[![][node-shield]][node-link]
[![][ts-shield]][ts-link]
[![][docker-shield]][docker-link]

<br>

<img src=".github/assets/terminal.svg" alt="终端演示：扫描、打包、发布一个 Windows 程序" width="860">

</div>

## ✨ 为什么用它

<table>
<tr>
<td width="33%" valign="top">

**🪄 不用重写**

直接给它现成的 `.exe`、`.jar`、`.swf`、`.iso` 或压缩包。它会读文件头、找出主程序，再挑一个能原样运行它的浏览器运行时。

</td>
<td width="33%" valign="top">

**🌐 在浏览器里跑**

程序在访问者浏览器的 WebAssembly 沙盒里执行（DOSBox、Wine、Ruffle、JVM、x86 PC、Linux 用户态），服务器只负责提供静态文件。

</td>
<td width="33%" valign="top">

**🚀 哪里都能发布**

产物是纯静态网站：可离线、可安装为 PWA，自带 Netlify / Cloudflare Pages / Vercel 的响应头配置，也可以推到 GitHub Pages 或自建服务器。

</td>
</tr>
</table>

## 🎬 实际运行效果

<div align="center">
<img src=".github/assets/showcase.webp" alt="六个样例程序在浏览器中运行" width="100%">
<br>
<sub>以上是 <a href="examples"><code>examples/</code></a> 里的样例用 <code>waa build</code> 打包后在 Chrome 中运行的真实截图。</sub>
</div>

## 🧩 支持哪些程序

| 输入 | 运行时 | 状态 |
| :-- | :-- | :-: |
| DOS 程序、DOS/4GW 游戏、js-dos 包 | js-dos（DOSBox） | ![][stable] |
| 16/32 位 Windows 程序（GDI、DirectDraw） | Boxedwine（Wine + x86 模拟） | ![][experimental] |
| Flash `.swf` | Ruffle | ![][stable] |
| Java `.jar`（Swing/AWT，Java 8/11/17） | CheerpJ | ![][stable] |
| `.iso`、软盘/硬盘镜像 | v86 | ![][stable] |
| 32 位 x86 Linux 终端程序、脚本 | CheerpX + xterm.js | ![][experimental] |
| 含 `index.html` 的文件夹或压缩包 | 原样发布 | ![][stable] |
| Electron 应用 | 渲染进程 + Electron API 替身 | ![][experimental] |
| 任意程序 + 你自己装好的 Windows 9x/DOS 硬盘镜像（`--guest`） | v86 或 DOSBox-X，程序在 D: 光驱里 | ![][experimental] |
| 64 位 Windows、64 位/ARM Linux 图形程序 | **stream**：生成 Docker 项目，在服务器上原生运行并用 Selkies 推流 | ![][experimental] |
| Android `.apk` | **stream**：Android 14 模拟器（docker-android），通过 noVNC 推流 | ![][experimental] |
| 任何程序，重写成真正的网页代码 | **`waa rebuild`**：Claude agent 读程序、截取原程序运行画面，写出网页版 | ![][experimental] |
| iOS、macOS | 不支持（扫描结果会说明原因） | – |

> [!NOTE]
> Windows 后端要在模拟的 CPU 上启动 Wine，首次打开需要 10–60 秒。需要 OpenGL/Direct3D 的程序、64 位程序和 .NET 程序在浏览器版里跑不了，可以改用 `--backend stream`；需要 DirectX/3dfx 的 Windows 9x 游戏可以用 `--guest win98.img --guest-engine dosboxX`。

## 🚀 快速开始

需要 Node.js 22.12 或更高版本。

```bash
npx webapp-anything build game.zip                                  # → out/game/
npx webapp-anything preview out/game                                # → http://127.0.0.1:4173
npx webapp-anything publish out/game --to github-pages --repo you/games
```

```bash
waa record out/game -o game.json              # 在 Chrome 里操作一遍，F2 标记截图点
waa check out/game -s game.json --update      # 保存为基准画面；之后去掉 --update 回放对比
waa build game.zip --guest win98.img          # 在你自己的 Windows 98 里运行（程序在 D:）
waa rebuild WINMINE.EXE                       # AI 重写成原生网页版（需要 ANTHROPIC_API_KEY，按用量计费）
```

**存档**：DOS 程序改过的文件、Flash 的 SharedObject、PC 镜像的整机状态都会自动保存在浏览器里。播放器的 **Saves**
按钮可以下载/导入 `.waasave` 存档文件；发布到 `waa serve` 的应用还能开启**同步**，用同步码
（`ABCDE-FGHIJ-KLMNO-PQRST`）在另一台设备上接着玩。

**AI 重写**：`waa rebuild` 让 Claude agent（默认 `claude-opus-5-5`）列出文件、解析菜单/对话框/字符串表、读字符串和十六进制、
在模拟器里运行原程序并截图，然后写 HTML/CSS/JS，再把自己的版本和原版并排截图对比、逐步修正。`--mcp` 可以接入任何 stdio MCP
服务器（比如 [REA](https://github.com/morluto/rea) 这类逆向工具）。所有写入都限制在输出目录里；开始前会先确认，因为 API
用量按你的 key 计费。默认开启 API 的服务端模型回退（`--no-fallbacks` 关闭）。

## ⚙️ 工作原理

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/pipeline-dark.svg">
  <img alt="扫描、选运行时、打包、发布" src=".github/assets/pipeline-light.svg" width="100%">
</picture>

1. **扫描**：不解压，只读需要的文件头（PE/NE/LE/MZ、ELF、Mach-O、SWF、ISO、JAR、asar……），并给压缩包里的每个候选程序打分。
2. **选运行时**：每个后端给扫描结果打分，分最高的胜出，也可以用 `--backend` 指定。
3. **打包**：按运行时的要求打包程序，再生成播放器页面。
4. **发布**：产物是带清单文件的静态网站，放在哪里都能用。

## 🛳 自建发布服务器

```bash
docker compose up -d                        # 数据在 waa-data 卷里
# 或者
waa serve --port 8080 --data ./waa-data     # 首次启动会打印发布 token
```

打开网页，拖入文件，确认识别结果，选运行时，点发布，就能拿到链接。文件按内容哈希存储，同一个运行时被一百个应用共用也只占一份空间。
对外开放上传时，请用 `--app-origin https://{slug}.apps.example.com` 让每个应用使用独立的源。

## ⚖️ 许可证

本项目使用 MIT 许可证。各运行时保留各自的许可证，并会随 bundle 一起附带：js-dos 和 Boxedwine 是 GPL-2.0；
CheerpJ/CheerpX 是闭源软件，个人和开源用途免费，商业用途需要向 Leaning Technologies 购买授权。

> [!IMPORTANT]
> 只发布你有权分发的软件。把程序转成网页版不会改变它原来的许可证。

完整文档见 [README.md](README.md) 和 [docs/](docs)。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

<!-- LINK GROUP -->

[back-to-top]: https://img.shields.io/badge/-BACK_TO_TOP-151515?style=flat-square
[ci-link]: https://github.com/Terse-AI/webapp-anything/actions/workflows/ci.yml
[ci-shield]: https://img.shields.io/github/actions/workflow/status/Terse-AI/webapp-anything/ci.yml?branch=main&label=CI&labelColor=black&logo=githubactions&logoColor=white&style=flat-square
[docker-link]: compose.yaml
[docker-shield]: https://img.shields.io/badge/docker-compose_ready-2496ed?labelColor=black&logo=docker&logoColor=white&style=flat-square
[experimental]: https://img.shields.io/badge/experimental-d29922?style=flat-square
[license-link]: LICENSE
[license-shield]: https://img.shields.io/badge/license-MIT-7aa2ff?labelColor=black&style=flat-square
[node-link]: https://nodejs.org
[node-shield]: https://img.shields.io/badge/node-%E2%89%A522.12-6ce09a?labelColor=black&logo=nodedotjs&logoColor=white&style=flat-square
[stable]: https://img.shields.io/badge/stable-2ea043?style=flat-square
[ts-link]: tsconfig.json
[ts-shield]: https://img.shields.io/badge/TypeScript-strict-3178c6?labelColor=black&logo=typescript&logoColor=white&style=flat-square
