# Simaeru

[日本語](README.md) | [English](README.en.md) | [简体中文](README.zh-CN.md)

一款 Windows 桌面应用，把在 **DMM / FANZA 和 DLsite** 购买的作品集中到一处，
进行浏览、搜索、下载、阅读和安装管理。

> 这是非官方应用，与 DMM、DLsite 无关。请遵守各网站的使用条款，并用于管理您本人购买的作品。

## 功能

- **库** — 同步购买记录，以带封面的列表浏览（可按分区、类型、品牌、标签、人物/系列、正则表达式、收藏筛选，可按使用日期排序）
- **下载** — 在应用内下载，中断后可继续，支持批量下载、DLsite 分卷下载、带宽限制，并显示件数、容量、速度和剩余时间
- **阅读・播放** — 漫画、CG、音声、视频 **无需解压 zip** 即可在应用内打开：图片阅读器（双页、缩放、锐化）、可同时查看台本和字幕的音声播放器、PDF、视频
- **文件管理** — 可按类型选择“保持压缩保管”或“解压后使用”。WAV 转 FLAC、只保留 MP3、删除与图片内容相同的 PDF、移入回收站、移动保存位置、导入已有文件
- **游戏** — 解压、判断是否需要安装、关联启动文件并启动。支持启动 DMM GAMES PLAYER 专用游戏，自动查找关联候选
- **在浏览器中阅读・游玩** — 保持登录状态，在应用内的窗口中打开
- **界面语言** — 日本語 / English / 简体中文

## 运行环境

| 项目 | 内容 |
|---|---|
| 操作系统 | Windows 10 / 11（64 位） |
| 构建所需 | Node.js 20 或更高版本 |
| 外部工具（可选） | 7-Zip、ffmpeg、NeeView。**不附带。** 电脑上已安装则直接使用，否则可以在设置中从官方发布页（GitHub Releases）获取（会比对校验和） |

## 开始使用

```bash
npm install
```

| 启动方式 | 内容 |
|---|---|
| `Simaeru.bat` | 平时启动（使用已构建的版本，没有时先构建再启动） |
| `Simaeru.bat build` | 更新源代码后，重新构建再启动 |
| `Simaeru.bat dev` | 开发模式 |

1. 点击侧栏左上角的 ⚙ →“账户”，登录要使用的网站（在网站自己的页面上登录）。
2. 点击工具栏的“同步购买记录”，导入已购买的作品。
3. 选择作品并点击“在应用中下载”。完成后，在“本地文件”中打开。

详细的功能文档在 [docs/](docs/README.md)（日语）。

## 基本原则

- **不移除 DRM。** 带 DRM 的作品只保管文件，并交给官方阅读器打开。
- **不以明文保存密码。** 保存的 ID/密码使用 Windows 的加密（DPAPI），无法加密时不保存。也不会替您点击登录按钮。
- **数据只保存在这台电脑上。** 不会向作者或任何第三方服务器发送任何内容。
- **删除文件时移入回收站。** 重新打包的文件在校验通过后才会替换原文件。

## 数据位置

| 位置 | 内容 |
|---|---|
| `%APPDATA%\simaeru\library.db` | 购买记录、本地文件记录、下载记录、设置（SQLite） |
| `%APPDATA%\simaeru\credentials.dpapi` | 保存的 ID/密码（已加密） |
| `%APPDATA%\simaeru\covers\` | 封面图片缓存 |
| `%APPDATA%\simaeru\tools\` | 从设置中安装的 7-Zip / ffmpeg / NeeView |
| `%APPDATA%\simaeru\Partitions\` | 各网站的登录会话 |
| 下载保存位置 | 默认为 `文档\Simaeru` |

## 开发

```bash
npm run typecheck
node tools/test-content-rules.mjs
node tools/i18n-keys.cjs --check
npx electron tools/test-library-local.js
npx electron tools/test-postprocess.js
```

项目结构、测试列表以及添加翻译的方法见 [docs/development.md](docs/development.md)（日语）。

## 许可证

- 应用本体：[MIT License](LICENSE)。
- 所用软件和外部工具的许可证：[THIRD_PARTY_NOTICES.en.md](THIRD_PARTY_NOTICES.en.md)（英语。也可以在设置的“关于本应用”中查看）。
