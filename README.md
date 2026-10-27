# 天气卡片 · Weather Widget

> 一个贴在 Windows 桌面上的磨砂玻璃天气卡片。自动定位，不抢焦点，不占任务栏。

![截图](docs/screenshot.png)

## 特性

- **真·磨砂玻璃** —— 走 Windows 11 原生 Acrylic 材质，实时模糊窗口背后的桌面内容（不是简单调低透明度）
- **自动定位** —— 不用选城市，启动就知道你在哪；三层降级：浏览器定位 → IP 归属 → 时区兜底
- **不打扰** —— 默认不置顶、不占任务栏、不抢焦点，就安静待在桌面上
- **无边框圆角** —— 320×356 的小卡片，拖动到任意位置并记住
- **数据零密钥** —— 天气与定位全部来自免费开放的 Open-Meteo / IP 归属接口，不需要注册任何 API Key
- **绿色免安装** —— 同时提供安装版（带开始菜单/桌面快捷方式）和单文件绿色版

## 下载安装

到 [Releases](../../releases) 页面下载：

| 文件 | 说明 |
| --- | --- |
| `WeatherWidget-1.0.0-x64-setup.exe` | 安装版。可选安装目录，自动创建快捷方式 |
| `WeatherWidget-1.0.0-x64-portable.exe` | 绿色版。双击即用，不写注册表（除自启动选项） |

> 未做代码签名，Windows SmartScreen 可能提示"未知发布者"，点「更多信息 → 仍要运行」即可。

## 使用

| 操作 | 效果 |
| --- | --- |
| 拖动卡片 | 移动位置，松手后自动记住 |
| 双击卡片 | 立即刷新天气 |
| 单击城市名 | 打开城市搜索（留空则跟随自动定位） |
| `F5` | 刷新 |
| 右键卡片 | 打开菜单：刷新 / 搜索城市 / 回到自动定位 / 桌面右键菜单显示 / 开机自启动 / 窗口置顶 / 退出 |
| 右上角 × | 退出 |

天气每 10 分钟自动刷新一次；定位结果缓存 30 分钟，超时会重新识别（手动选过的城市不会被覆盖）。

### 桌面右键菜单

在卡片上右键勾选「桌面右键菜单显示」后，**桌面空白处右键**会多出一项「显示天气卡片」，点一下就启动（已在运行则直接唤出，不会开第二个）。

- 只写 `HKCU\Software\Classes\DesktopBackground\Shell`，不碰 HKLM、不需要管理员权限
- 卸载安装版时自动清理这一项；取消勾选也会删掉
- Windows 11 的桌面右键是新版精简菜单，这一项在「显示更多选项」（或按 `Shift`+`F10`）里

### 关于"窗口置顶"

默认**不置顶**——卡片待在普通窗口层，切到别的程序时不会浮在最前面。如果你希望它一直在最上层，右键菜单勾选「窗口置顶」即可。

## 定位是怎么工作的

按可信度从高到低尝试，任一层成功即返回：

1. **系统定位**（Chromium geolocation，若系统定位服务开启）
2. **IP 归属**（主源 `ip.sb`、副源 `ipwho.is`，两源互相校验；时区与系统时区不一致的结果会被降权）
3. **默认城市**（北京），保证任何情况下都有内容显示

> 主进程用 Node 的 `fetch` 直接发请求，**不跟随 Windows 系统代理**。这是刻意的：机器上挂着代理/VPN 时，渲染进程的请求会走代理出口，IP 可能落到境外机房，定位就错到别的国家（开发期踩过这个坑，一度显示"伦敦"）。

## 磨砂是怎么实现的

Windows 11 22H2（build ≥ 22621）上使用 Electron 的 `backgroundMaterial: "acrylic"`，由桌面窗口管理器实时合成模糊，截图/录屏里的模糊也是真实的。

低于该版本的系统自动退回"半透明渐变"模式（窗口 `transparent: true` + 卡片自身的玻璃渐变），观感接近但没有真实模糊。

两种模式的差别对页面有影响：Acrylic 模式下卡片背景必须全透明，否则会盖住系统磨砂层。主进程通过 `additionalArguments` 把 `--wgt-acrylic=1|0` 透给渲染进程，页面据此加 `body.acrylic` 或 `body.solid`。

## 自己构建

```bash
git clone <repo-url>
cd weather-widget
npm install
npm start          # 开发运行
npm run dist       # 打包出 dist/ 下的 setup.exe 与 portable.exe
```

- 打包配置在 `package.json` 的 `build` 字段（NSIS + portable 双目标）
- 图标改完 `icon.png` 后跑 `npm run icon`（需要 ffmpeg），会生成 16/24/32/48/64/128/256 七种尺寸的 `icon.ico`；只有 256 单尺寸的话，任务栏小图标会发虚
- 只构建解包目录（调试用）：`npm run dist:dir`

### 构建踩坑：winCodeSign 解压失败

如果构建停在下载 `winCodeSign-2.6.0.7z` 之后，并报：

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权 :
  ...\Cache\winCodeSign\<随机数>\darwin\10.12\lib\libcrypto.dylib
```

原因是这个包里含两个 **macOS** 的 `.dylib` 符号链接，解压时 7za 带 `-snld` 要真实创建符号链接；未开启「开发者模式」或非管理员账户没有这个权限，于是整包解压失败、构建中断。Windows 侧完全用不到那两个文件。

绕过办法（实测可用）：跳过 electron-builder 的资源编辑，自己用 rcedit 写图标和版本信息，再用 `--prepackaged` 出安装包。

```bash
# 0) 手动解压 winCodeSign 到固定目录（符号链接报错可忽略，其余文件都已就位）
mkdir -p "$LOCALAPPDATA/electron-builder/Cache/winCodeSign-vendor"
node_modules/7zip-bin/win/x64/7za.exe x -y winCodeSign-2.6.0.7z \
  "-o$LOCALAPPDATA/electron-builder/Cache/winCodeSign-vendor"

# 1) 只解包，不碰资源
npx electron-builder --win --dir -c.win.signAndEditExecutable=false

# 2) 自己写图标 + 版本信息（rcedit 就在上面解出来的目录里）
"$LOCALAPPDATA/electron-builder/Cache/winCodeSign-vendor/rcedit-x64.exe" \
  dist/win-unpacked/WeatherWidget.exe --set-icon icon.ico \
  --set-version-string ProductName "天气卡片" \
  --set-version-string FileDescription "桌面天气卡片" \
  --set-file-version "1.0.0.0" --set-product-version "1.0.0"

# 3) 用现成的解包目录出安装包
npx electron-builder --win nsis portable --prepackaged dist/win-unpacked
```

CI（GitHub Actions 的 Windows runner）通常自带该权限，`npm run dist` 可以直接跑通。

国内网络构建建议设镜像，否则 115MB 的 Electron 运行时会卡很久：

```bash
export ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
```


## 目录结构

```
weather-widget/
├── main.js            # 主进程：窗口、Acrylic、位置记忆、右键菜单、IP 归属查询
├── preload.js         # contextBridge 暴露的最小接口
├── widget.html        # 全部界面与逻辑（单文件，无框架、无构建步骤）
├── icon.png / icon.ico
└── tools/make-icon.py # 多尺寸 ico 生成
```

## 已知限制

- 只在 Windows 上验证过。macOS / Linux 未测试（Acrylic 是 Windows 专有，其他平台会走半透明回退）
- 未做代码签名与自动更新
- 天气数据依赖 Open-Meteo 可用性；请求失败时保留上一次结果并标注"刷新失败"
- 高 DPI 缩放下窗口尺寸按逻辑像素计算，暂未做逐屏适配

## 数据来源

- 天气：[Open-Meteo](https://open-meteo.com/)（CC BY 4.0）
- 城市搜索：Open-Meteo Geocoding API
- IP 归属：[ip.sb](https://ip.sb/) / [ipwho.is](https://ipwho.is/)

## License

[MIT](LICENSE)
