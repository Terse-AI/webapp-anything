# webapp-anything

**把桌面软件变成网页版，一条命令发布。**

丢给它一个老 DOS 游戏、Windows `.exe`、Java `.jar`、Flash 动画、Linux 程序或可启动的磁盘镜像，它会：

1. **扫描**：识别文件格式（PE/NE/LE/MZ、ELF、Mach-O、SWF、ISO、JAR、asar……），在压缩包里找出真正的主程序；
2. **选运行时**：给每个后端打分，挑一个能在浏览器里跑它的；
3. **打包**：生成一个纯静态网站（播放器页面 + 程序 + 版本锁定、校验过哈希的运行时）；
4. **发布**：发到自建服务器、GitHub Pages 或任何静态托管。

```bash
npx webapp-anything build game.zip
npx webapp-anything preview out/game
npx webapp-anything publish out/game --to github-pages --repo you/games
```

## 支持的程序

| 输入 | 运行时 | 状态 |
| --- | --- | --- |
| DOS 程序、DOS/4GW 游戏、js-dos 包 | js-dos（DOSBox） | 稳定 |
| 16/32 位 Windows 程序（GDI、DirectDraw） | Boxedwine（Wine + x86 模拟） | 实验 |
| Flash `.swf` | Ruffle | 稳定 |
| Java `.jar`（Swing/AWT，Java 8/11/17） | CheerpJ | 稳定 |
| `.iso`、软盘/硬盘镜像 | v86 | 稳定 |
| 32 位 x86 Linux 终端程序、脚本 | CheerpX + xterm.js | 实验 |
| 含 `index.html` 的文件夹/压缩包 | 原样发布 | 稳定 |
| Electron 应用 | 渲染进程 + Electron API 替身 | 实验 |
| 64 位 Windows、64 位/ARM Linux 图形程序 | **stream**：生成 Docker 项目，服务器原生运行并用 Selkies 推流 | 实验 |
| Android、iOS、macOS | 不支持（扫描结果会说明原因） | – |

`examples/` 里每一类都有样例，并在真实浏览器里验证过：DOS 程序输出文字，Flash 动画在动，软盘经 SeaBIOS 启动，
Win32 和 Swing 窗口能响应点击，Linux 程序能在终端里读输入。

## 自建发布服务器

```bash
waa serve --port 8080 --data ./waa-data   # 首次启动会打印发布 token
docker compose up -d                      # 或者用 Docker
```

打开网页，拖入文件，看识别结果，选运行时，点发布，就能拿到链接。文件按内容哈希存储，同一个运行时被一百个应用共用也只占一份空间。
对外开放上传时，请用 `--app-origin https://{slug}.apps.example.com` 让每个应用使用独立的源。

## 法律

本项目使用 MIT 许可证。各运行时保留各自的许可证，并会随 bundle 一起附带：js-dos 和 Boxedwine 是 GPL-2.0；
CheerpJ/CheerpX 是闭源软件，个人和开源用途免费，商业用途需要向 Leaning Technologies 购买授权。
**只发布你有权分发的软件。**

完整文档见 [README.md](README.md)。
