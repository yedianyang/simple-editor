# Mac App Store 分发调研报告

**调研时间**: 2026-02-16
**调研员**: researcher
**项目**: FieldCorder DAW

---

## ⚠️ 核心发现：AudioUnit 插件加载与 MAS 的根本性冲突

**重大限制**: Mac App Store **不允许**使用 `com.apple.security.temporary-exception.audio-unit-host` entitlement，这意味着 **我们无法在 MAS 版本中加载第三方 AudioUnit 插件**。

这是一个关键的架构决策点，直接影响产品的分发策略。

---

## 目录

1. [背景与当前配置分析](#背景与当前配置分析)
2. [Mac App Store 上架完整流程](#mac-app-store-上架完整流程)
3. [App Sandbox 对 Native Addon 的影响](#app-sandbox-对-native-addon-的影响)
4. [AudioUnit/VST 插件加载的致命限制](#audiounitvst-插件加载的致命限制)
5. [Electron 常见审核被拒原因](#electron-常见审核被拒原因)
6. [electron-builder MAS 配置](#electron-builder-mas-配置)
7. [证书和 Provisioning Profile](#证书和-provisioning-profile)
8. [Entitlements 配置详解](#entitlements-配置详解)
9. [成功案例分析](#成功案例分析)
10. [分发策略建议](#分发策略建议)
11. [参考资料](#参考资料)

---

## 背景与当前配置分析

### 项目当前状态

**package.json 配置**:
```json
{
  "build": {
    "appId": "com.fieldcorder.daw",
    "productName": "FieldCorder",
    "mac": {
      "category": "public.app-category.music",
      "target": [{ "target": "dmg", "arch": "arm64" }],
      "hardenedRuntime": true,
      "identity": null,
      "entitlements": "resources/entitlements.plist",  // ❌ 文件不存在
      "entitlementsInherit": "resources/entitlements.plist"
    }
  }
}
```

**electron/main.ts 关键配置**:
```typescript
webPreferences: {
  sandbox: false,  // ❌ MAS 要求 sandbox: true
  nodeIntegration: false,
  contextIsolation: true
}
```

### 🚨 当前配置的问题

| 问题 | 严重程度 | 影响 |
|------|----------|------|
| `sandbox: false` | 🔴 高 | MAS 审核必定被拒 |
| 缺少 entitlements.plist | 🔴 高 | 无法签名和上传 |
| 加载 native addon (.node 文件) | 🟡 中 | 需要特殊签名和配置 |
| 访问文件系统 (fs 模块) | 🟡 中 | 需要沙箱豁免 entitlements |
| 没有 MAS 构建目标 | 🟡 中 | 无法打包 .pkg 安装包 |

---

## Mac App Store 上架完整流程

### 步骤概览

```
1. 准备证书和 Provisioning Profile
   ↓
2. 配置 entitlements 文件（.plist）
   ↓
3. 配置 electron-builder MAS 目标
   ↓
4. 签名应用和所有 native 模块
   ↓
5. 构建 .pkg 安装包
   ↓
6. 使用 Transporter 上传到 App Store Connect
   ↓
7. 提交审核（等待 1-7 天）
   ↓
8. 审核通过 → 上架发布
```

### 1. 准备证书（Apple Developer Program）

需要在 [Apple Developer Portal](https://developer.apple.com/account) 创建以下证书：

| 证书类型 | 用途 | 标识 |
|----------|------|------|
| **Mac App Distribution** | 签名应用 | `3rd Party Mac Developer Application` |
| **Mac Installer Distribution** | 签名 .pkg 安装包 | `3rd Party Mac Developer Installer` |

**创建步骤**:
1. 登录 Apple Developer → Certificates, Identifiers & Profiles
2. 点击 "+" 创建新证书
3. 选择 "Mac App Distribution" 和 "Mac Installer Distribution"
4. 上传 CSR（Certificate Signing Request）文件
5. 下载证书并双击安装到钥匙串

### 2. 创建 App ID

- **App ID**: `com.fieldcorder.daw`（与 package.json 的 appId 一致）
- **Capabilities**:
  - ✅ App Sandbox
  - ✅ Audio Input (麦克风访问)
  - ✅ User Selected Files (用户选择的文件读写)

### 3. 创建 Provisioning Profile

1. 在 Apple Developer → Profiles 页面
2. 选择 "Mac App Store" → "macOS App Development"（开发测试）
3. 再创建一个 "macOS App Distribution"（正式发布）
4. 选择 App ID 和证书
5. 下载 `.provisionprofile` 文件

**文件位置**:
- 开发: `build/AppleDevelopment.provisionprofile`
- 发布: `build/MacAppStore.provisionprofile`

---

## App Sandbox 对 Native Addon 的影响

### Sandbox 基本原则

Mac App Store 要求所有应用在 **App Sandbox** 中运行，这是一个受限环境：

- ❌ 无法访问系统文件（除非用户明确选择）
- ❌ 无法访问其他应用的数据
- ❌ 无法执行外部代码（除非签名）
- ✅ 只能访问用户选择的文件
- ✅ 只能使用授权的系统服务（网络、麦克风等）

### Native Addon (.node 文件) 的特殊要求

#### 问题 1: Asar 打包导致签名失败

**原因**: Apple 无法验证 asar 归档文件内部的二进制文件签名。

**解决方案**: 将所有 `.node` 文件解包到 `app.asar.unpacked` 目录外。

```json
// package.json
{
  "build": {
    "files": [
      "dist/**/*",
      "dist-electron/**/*",
      "!native/build/Release/**/*"  // 排除，改用 extraResources
    ],
    "extraResources": [
      {
        "from": "native/build/Release",
        "to": "native",
        "filter": ["*.node"]
      }
    ],
    "asarUnpack": [
      "**/node_modules/**/native/**/*.node"
    ]
  }
}
```

#### 问题 2: Native 模块需要独立签名

每个 `.node` 文件都必须使用正确的 entitlements 单独签名。

**electron-builder 自动处理**: 使用 `@electron/osx-sign` 时会自动签名所有二进制文件。

**手动签名示例**（如果需要）:
```bash
codesign --sign "3rd Party Mac Developer Application: Your Name (TEAMID)" \
  --entitlements build/entitlements.inherit.mas.plist \
  --options runtime \
  --timestamp \
  --force \
  YourApp.app/Contents/Resources/native/fieldcorder_native.node
```

#### 问题 3: Sandbox 限制访问外部代码

**影响**: Native addon 可以运行，但如果它尝试访问系统路径、其他应用数据或执行外部命令，会被沙箱拒绝。

**FieldCorder 的情况**:
- ✅ AudioUnit 扫描（使用 `AudioComponentFindNext` API）- 应该可以
- ❌ 加载第三方 AudioUnit 插件 - **被沙箱阻止**（见下一节）
- ✅ 文件读写（通过用户选择）- 需要 entitlement

---

## AudioUnit/VST 插件加载的致命限制

### 🔴 核心问题：`com.apple.security.temporary-exception.audio-unit-host` 不被 MAS 接受

Apple 提供了一个特殊的 entitlement 允许加载非沙箱安全的 AudioUnit 插件：

```xml
<key>com.apple.security.temporary-exception.audio-unit-host</key>
<true/>
```

**但是**，[Apple Technical Note TN2312](https://developer.apple.com/library/archive/technotes/tn2312/_index.html) 明确指出：

> ⚠️ **This entitlement is not supported on the Mac App Store.**

### 官方文档说明

来自 [App Sandbox Temporary Exception Entitlements](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/AppSandboxTemporaryExceptionEntitlements.html):

> "Allows you to load Audio Units that are not sandbox-safe. **Using this key can cause the system to disable the host application's sandbox completely.**"

**结果**: 如果在 entitlements 中包含此键，App Store Connect 会拒绝上传，错误信息：

```
ERROR ITMS-90296: "App sandbox not enabled.
The following executables must include the
'com.apple.security.app-sandbox' entitlement
with a Boolean value of true in the entitlements property list."
```

### 为什么 Logic Pro 可以？

Logic Pro **也在 Mac App Store 上**，并且可以加载第三方 AudioUnit 插件。可能的原因：

1. **Apple 特权**: Logic Pro 是 Apple 自己的软件，可能有内部豁免
2. **不同的沙箱配置**: Apple 可能使用了未公开的 entitlements
3. **插件验证机制**: Logic Pro 使用 `auvaltool` 严格验证插件，只加载"沙箱安全"的 AU

但对于第三方开发者，**我们无法获得此权限**。

### VST3 插件同样受限

VST3 插件通常位于：
- `/Library/Audio/Plug-Ins/VST3/`
- `~/Library/Audio/Plug-Ins/VST3/`

在 App Sandbox 中，应用**无法访问这些路径**，除非：

1. 用户手动选择插件文件（`com.apple.security.files.user-selected.read-only`）
2. 使用 temporary exception（但不被 MAS 接受）

**结论**: VST3 插件加载在 MAS 版本中同样不可行。

### 可行的替代方案

#### 方案 A: 仅使用内置效果器（当前实现）

✅ **优点**:
- 完全兼容 App Sandbox
- 无需额外权限
- 可以顺利通过 MAS 审核

❌ **缺点**:
- 功能受限，无法使用专业插件
- 竞争力不足（专业 DAW 用户需要插件支持）

**当前状态**: FieldCorder 已实现此方案（`src/plugins/PluginHost.ts` 的 Web Audio API 内置效果器）。

#### 方案 B: 双版本策略

**MAS 版本（FieldCorder Lite）**:
- ✅ 仅内置效果器
- ✅ 完全沙箱兼容
- ✅ 用户通过 App Store 发现和购买

**直接分发版本（FieldCorder Pro）**:
- ✅ 支持 VST3/AudioUnit 插件
- ✅ 使用开发者 ID 签名（公证 + 直接下载）
- ✅ 高级用户获得完整功能

**实施方案**:
```json
// package.json
{
  "build": {
    "mac": {
      "target": [
        { "target": "dmg", "arch": "arm64" },      // 直接分发
        { "target": "mas", "arch": "arm64" }       // App Store
      ]
    },
    "mas": {
      "entitlements": "build/entitlements.mas.plist",
      "entitlementsInherit": "build/entitlements.mas.inherit.plist",
      "provisioningProfile": "build/MacAppStore.provisionprofile"
    }
  }
}
```

#### 方案 C: 放弃 MAS 分发，仅直接分发

如果插件支持是核心功能，可以完全放弃 App Store：

✅ **优点**:
- 完整功能，无限制
- 更快迭代（无需审核）
- 避免 30% 分成

❌ **缺点**:
- 失去 App Store 的曝光度
- 用户需要手动下载和更新
- 需要自建支付和许可系统

---

## Electron 常见审核被拒原因

### 1. 使用私有 API（Private API）

**问题**: Electron 框架本身使用了某些 macOS 私有 API（如 `CAContext`、`NSAccessibilityRemoteUIElement`）。

**被拒案例** ([Issue #20027](https://github.com/electron/electron/issues/20027)):
```
ITMS-90338: Non-public API usage:
- CAContext
- CALayerHost
- NSAccessibilityRemoteUIElement
- NSThemeFrame
```

**解决方案**:
- 使用最新版本的 Electron（问题在新版本中被修复）
- 当前项目使用 `electron@^28.1.0` - ✅ 应该没问题

**验证方法**:
```bash
# 检查私有 API 使用
otool -L YourApp.app/Contents/MacOS/YourApp | grep -i private
```

### 2. Sandbox 未启用或配置错误

**错误信息**:
```
ITMS-90296: App sandbox not enabled.
```

**原因**: `com.apple.security.app-sandbox` 未设置为 `true`。

**解决方案**: 在 `entitlements.mas.plist` 中必须包含：
```xml
<key>com.apple.security.app-sandbox</key>
<true/>
```

### 3. 使用不支持的 Entitlements

**错误示例**:
```
ITMS-90254: The entitlement
'com.apple.security.temporary-exception.audio-unit-host'
is not supported on the Mac App Store.
```

**解决方案**: 移除所有 `com.apple.security.temporary-exception.*` 键（MAS 不接受）。

### 4. 签名问题

**常见错误**:
- 证书过期或不匹配
- Native 模块未签名
- Provisioning Profile 缺失

**验证签名**:
```bash
# 检查应用签名
codesign --verify --deep --strict --verbose=2 YourApp.app

# 检查 entitlements
codesign -d --entitlements - YourApp.app
```

### 5. Info.plist 缺少必要描述

**错误**: 应用请求麦克风权限但未提供说明。

**解决方案**: 在 `package.json` 的 `extendInfo` 中添加：
```json
{
  "build": {
    "mac": {
      "extendInfo": {
        "NSMicrophoneUsageDescription": "FieldCorder needs microphone access for audio recording.",
        "NSCameraUsageDescription": "FieldCorder may need camera access for video recording features."
      }
    }
  }
}
```

当前项目已包含 `NSMicrophoneUsageDescription` - ✅ 正确。

### 6. 应用元数据不完整

App Store Connect 要求：
- 应用描述（至少 10 个字符）
- 关键词
- 分类（已配置为 `public.app-category.music` ✅）
- 截图（至少 1 张，分辨率要求）
- 隐私政策 URL（如果收集用户数据）

---

## electron-builder MAS 配置

### 完整 package.json 配置示例

```json
{
  "name": "fieldcorder-daw",
  "version": "1.0.0",
  "description": "Lightweight DAW for multi-channel environmental recording editing",
  "main": "dist-electron/main.js",
  "author": "Your Name <your.email@example.com>",
  "license": "MIT",
  "build": {
    "appId": "com.fieldcorder.daw",
    "productName": "FieldCorder",
    "copyright": "Copyright © 2026 Your Company",

    "mac": {
      "category": "public.app-category.music",
      "icon": "resources/icon.icns",
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "target": [
        {
          "target": "dmg",
          "arch": ["arm64", "x64"]
        },
        {
          "target": "mas",
          "arch": ["arm64", "x64"]
        }
      ],
      "extendInfo": {
        "NSMicrophoneUsageDescription": "FieldCorder needs microphone access for audio recording.",
        "NSCameraUsageDescription": "FieldCorder may need camera access for video recording features.",
        "LSMinimumSystemVersion": "11.0"
      }
    },

    "mas": {
      "type": "distribution",
      "category": "public.app-category.music",
      "entitlements": "build/entitlements.mas.plist",
      "entitlementsInherit": "build/entitlements.mas.inherit.plist",
      "provisioningProfile": "build/MacAppStore.provisionprofile",
      "hardenedRuntime": false,
      "binaries": [
        "Contents/Resources/native/*.node"
      ]
    },

    "dmg": {
      "sign": false,
      "contents": [
        { "x": 130, "y": 220 },
        { "x": 410, "y": 220, "type": "link", "path": "/Applications" }
      ]
    },

    "files": [
      "dist/**/*",
      "dist-electron/**/*",
      "resources/**/*"
    ],

    "extraResources": [
      {
        "from": "native/build/Release",
        "to": "native",
        "filter": ["*.node"]
      }
    ],

    "asarUnpack": [
      "**/node_modules/**/native/**/*.node"
    ]
  },

  "scripts": {
    "build": "tsc && vite build && tsc -p tsconfig.electron.json",
    "build:mas": "npm run build && npm run native:build && electron-builder --mac mas",
    "build:dmg": "npm run build && npm run native:build && electron-builder --mac dmg"
  }
}
```

### 关键配置项说明

| 配置项 | 说明 |
|--------|------|
| `mas.type: "distribution"` | MAS 分发类型（非开发） |
| `mas.hardenedRuntime: false` | MAS 构建不需要 hardened runtime |
| `mas.binaries` | 指定需要签名的额外二进制文件 |
| `mac.hardenedRuntime: true` | DMG 分发需要 hardened runtime |
| `extraResources` | 将 native addon 放在 asar 外部 |

---

## 证书和 Provisioning Profile

### 证书管理

#### 1. 创建 CSR（Certificate Signing Request）

```bash
# 在 macOS 钥匙串访问中
# 钥匙串访问 → 证书助理 → 从证书颁发机构请求证书
# 用户电子邮件：your.email@example.com
# 常用名称：Your Name
# 选择"存储到磁盘"
```

生成 `CertificateSigningRequest.certSigningRequest` 文件。

#### 2. 下载并安装证书

1. 上传 CSR 到 Apple Developer Portal
2. 下载 `.cer` 文件
3. 双击安装到"登录"钥匙串

**验证安装**:
```bash
security find-identity -v -p codesigning
```

应该看到：
```
1) ABCDEF1234567890 "3rd Party Mac Developer Application: Your Name (TEAMID)"
2) FEDCBA0987654321 "3rd Party Mac Developer Installer: Your Name (TEAMID)"
```

#### 3. 导出证书（可选，用于 CI/CD）

```bash
# 导出为 .p12 格式
security export -k login.keychain -t identities \
  -f pkcs12 -o certificates.p12 -P "your_password"
```

### Provisioning Profile 配置

#### 创建 Profile

1. Apple Developer → Profiles → "+"
2. 选择 **Mac App Store** → **macOS App Development**（测试）或 **macOS App Distribution**（发布）
3. 选择 App ID: `com.fieldcorder.daw`
4. 选择证书
5. 下载 `.provisionprofile` 文件

#### 嵌入到应用

**方法 1: electron-builder 自动处理**（推荐）

将 `.provisionprofile` 放到 `build/MacAppStore.provisionprofile`，electron-builder 会自动嵌入。

**方法 2: 手动嵌入**

```bash
cp MacAppStore.provisionprofile \
  YourApp.app/Contents/embedded.provisionprofile
```

#### 验证 Profile

```bash
# 查看 profile 信息
security cms -D -i MacAppStore.provisionprofile
```

应该包含：
- `ApplicationIdentifierPrefix`: 你的 Team ID
- `Entitlements`: 授权列表
- `ProvisionedDevices`: 允许的设备（仅开发 profile）

---

## Entitlements 配置详解

### 文件结构

需要创建两个 entitlements 文件：

1. **entitlements.mas.plist**: 主应用的授权
2. **entitlements.mas.inherit.plist**: 子进程（Helper、Renderer）继承的授权

### entitlements.mas.plist（主应用）

创建文件：`build/entitlements.mas.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- ====== 基础沙箱 ====== -->
    <key>com.apple.security.app-sandbox</key>
    <true/>

    <!-- ====== 音频录制 ====== -->
    <key>com.apple.security.device.audio-input</key>
    <true/>

    <!-- ====== 用户选择的文件读写 ====== -->
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>

    <!-- ====== 网络访问（如果需要云同步、更新检查等）====== -->
    <key>com.apple.security.network.client</key>
    <true/>

    <!-- ====== Application Groups（可选，用于进程间通信）====== -->
    <key>com.apple.security.application-groups</key>
    <array>
        <string>$(TeamIdentifierPrefix)com.fieldcorder.daw</string>
    </array>

    <!-- ====== 音乐文件夹访问（可选）====== -->
    <!-- 如果需要自动扫描 ~/Music 目录 -->
    <key>com.apple.security.files.user-selected.read-only</key>
    <true/>

    <!-- ⚠️ 不要包含以下 entitlements（MAS 不接受）-->
    <!-- com.apple.security.temporary-exception.* -->
    <!-- com.apple.security.cs.allow-unsigned-executable-memory -->
    <!-- com.apple.security.cs.disable-library-validation -->
</dict>
</plist>
```

### entitlements.mas.inherit.plist（子进程）

创建文件：`build/entitlements.mas.inherit.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- 基础沙箱（必须） -->
    <key>com.apple.security.app-sandbox</key>
    <true/>

    <!-- 继承主应用的授权 -->
    <key>com.apple.security.inherit</key>
    <true/>

    <!-- 音频输入（如果子进程需要访问麦克风）-->
    <key>com.apple.security.device.audio-input</key>
    <true/>
</dict>
</plist>
```

### Entitlements 字段说明

| Entitlement Key | 作用 | FieldCorder 是否需要 |
|-----------------|------|---------------------|
| `com.apple.security.app-sandbox` | 启用沙箱（必须） | ✅ 必需 |
| `com.apple.security.device.audio-input` | 麦克风访问 | ✅ 必需 |
| `com.apple.security.device.camera` | 摄像头访问 | ❌ 不需要 |
| `com.apple.security.files.user-selected.read-write` | 用户选择的文件读写 | ✅ 必需 |
| `com.apple.security.files.user-selected.read-only` | 用户选择的文件只读 | ✅ 可选 |
| `com.apple.security.network.client` | 网络客户端 | ✅ 可选 |
| `com.apple.security.network.server` | 网络服务器 | ❌ 不需要 |
| `com.apple.security.application-groups` | 应用组（进程间通信） | ✅ 可选 |
| `com.apple.security.temporary-exception.audio-unit-host` | AudioUnit 插件加载 | ❌ **MAS 不支持** |

### 非 MAS 版本的 entitlements（DMG 分发）

创建文件：`build/entitlements.mac.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- ⚠️ 注意：非 MAS 版本不需要启用沙箱 -->
    <!-- 但如果启用了 hardenedRuntime，需要以下授权 -->

    <key>com.apple.security.cs.allow-jit</key>
    <true/>

    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>

    <!-- 如果需要加载 AudioUnit 插件（仅非 MAS）-->
    <key>com.apple.security.device.audio-input</key>
    <true/>

    <!-- 允许加载动态库 -->
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
```

---

## 成功案例分析

### Electron 应用在 Mac App Store 的成功案例

#### 1. **Slack** (部分功能受限)

- **状态**: 曾在 MAS 上架，后来改为直接分发
- **原因**: MAS 的沙箱限制导致某些功能无法实现（如自动更新、深度集成）
- **启示**: 即使大公司也因沙箱限制放弃 MAS

#### 2. **Visual Studio Code** (未上架 MAS)

- **状态**: 仅通过官网直接分发
- **原因**: 需要访问文件系统、终端、扩展安装等功能，与沙箱不兼容
- **启示**: 专业工具类应用更适合直接分发

#### 3. **1Password 8** (已上架 MAS)

- **技术栈**: Electron + Rust
- **策略**:
  - ✅ 完全沙箱兼容
  - ✅ 使用 iCloud 同步（沙箱允许）
  - ✅ 限制文件系统访问
- **启示**: 可以通过架构设计避开沙箱限制

#### 4. **Bear Writer** (已上架 MAS)

- **状态**: 成功上架，评价很高
- **策略**:
  - 使用 iCloud 存储（沙箱友好）
  - 不需要访问系统级资源
- **启示**: 用户数据类应用更适合 MAS

### DAW/音频类应用在 MAS 的情况

#### ✅ **GarageBand** (Apple 官方)

- **插件支持**: 可以加载 AudioUnit 插件
- **特殊待遇**: Apple 自己的应用，可能有内部豁免

#### ✅ **Logic Pro** (Apple 官方)

- **插件支持**: 完整的 AU 插件支持
- **特殊待遇**: 同上

#### ❌ **第三方 DAW** (Pro Tools, Reaper, Ableton Live)

- **状态**: **都没有上架 MAS**
- **分发方式**: 官网直接下载
- **原因**:
  - 需要加载第三方插件（VST/AU）
  - 需要访问系统音频设备
  - 需要实时音频处理权限

#### ✅ **Loopy Pro** (上架 MAS)

- **类型**: Loop 采样器 + DAW
- **策略**:
  - 仅使用内置效果器
  - 不支持第三方插件
  - 沙箱兼容

**结论**: **专业 DAW 如果需要第三方插件支持，通常不会选择 MAS 分发。**

---

## 分发策略建议

### 方案对比

| 方案 | MAS | 直接分发 (DMG) | 双版本策略 |
|------|-----|----------------|------------|
| **插件支持** | ❌ 仅内置 | ✅ VST3/AU | ✅ 内置 + 完整 |
| **分发成本** | 低（App Store 托管） | 中（需要 CDN） | 高（维护两个版本） |
| **用户信任** | 高（App Store 验证） | 中（需要公证） | 高 |
| **更新便利** | 高（自动） | 中（需要实现） | 中 |
| **Apple 分成** | 30% | 0% | MAS 版本 30% |
| **审核周期** | 1-7 天 | 无 | 1-7 天 |
| **功能限制** | 严格 | 宽松 | 分层 |

### 🥇 **推荐方案：双版本策略**

**理由**:
1. ✅ **覆盖不同用户群体**:
   - MAS 版本（Lite）: 入门用户、学生、简单需求
   - 直接分发（Pro）: 专业用户、需要插件支持

2. ✅ **最大化收益**:
   - MAS 版本定价较低（$29.99）吸引大众
   - Pro 版本定价较高（$79.99）满足专业需求

3. ✅ **风险分散**:
   - 如果 MAS 审核被拒，仍有直接分发版本
   - 不依赖单一渠道

### 实施步骤

#### Phase 1: 准备 MAS 版本（2-3 周）

**Week 1: 配置和证书**
- [ ] 创建 Apple Developer 账号（$99/年）
- [ ] 创建 App ID 和 Provisioning Profile
- [ ] 创建证书：Mac App Distribution、Mac Installer Distribution
- [ ] 配置 entitlements 文件（`entitlements.mas.plist`、`entitlements.mas.inherit.plist`）

**Week 2: 代码调整**
- [ ] 修改 `electron/main.ts`: `sandbox: true`
- [ ] 修改 native addon 加载逻辑，检测 MAS 环境
- [ ] 添加条件编译标志区分 MAS/DMG 版本
- [ ] 签名 `.node` 文件

```typescript
// electron/main.ts
const isMAS = process.mas || process.platform === 'mas';

webPreferences: {
  sandbox: isMAS ? true : false,  // MAS 强制沙箱
  nodeIntegration: false,
  contextIsolation: true
}

// 检测环境，禁用插件加载
if (isMAS) {
  console.log('MAS build: Native plugin loading disabled');
  pluginHostNative = null;
}
```

**Week 3: 构建和测试**
- [ ] 配置 `package.json` 的 `mas` 目标
- [ ] 本地构建 MAS 版本：`npm run build:mas`
- [ ] 使用开发 Provisioning Profile 测试
- [ ] 验证签名：`codesign --verify --deep --strict YourApp.app`
- [ ] 测试沙箱限制（文件访问、麦克风权限等）

#### Phase 2: 准备 DMG 版本（1 周）

**Week 4: 完整功能版本**
- [ ] 保持 `sandbox: false`
- [ ] 启用完整 native addon 功能
- [ ] 配置 Developer ID 签名
- [ ] 公证（Notarization）

```bash
# 公证流程
npm run build:dmg
xcrun notarytool submit dist/FieldCorder-1.0.0-arm64.dmg \
  --apple-id "your.email@example.com" \
  --password "app-specific-password" \
  --team-id "TEAMID" \
  --wait

# 订书钉（Staple）
xcrun stapler staple dist/FieldCorder-1.0.0-arm64.dmg
```

#### Phase 3: 上传和审核（1 周）

**MAS 版本提交**:
1. 使用 Transporter 上传 `.pkg` 到 App Store Connect
2. 填写应用元数据（描述、截图、关键词）
3. 提交审核
4. 等待审核结果（通常 1-7 天）

**DMG 版本发布**:
1. 上传到 CDN 或 GitHub Releases
2. 创建下载页面
3. 添加自动更新机制（electron-updater）

---

## 构建和发布脚本

### package.json scripts

```json
{
  "scripts": {
    "build": "tsc && vite build && tsc -p tsconfig.electron.json",
    "native:build": "cmake-js compile --directory native --runtime electron --runtime-version 28.1.0 --arch arm64",

    "build:mas": "npm run build && npm run native:build && electron-builder --mac mas --universal",
    "build:dmg": "npm run build && npm run native:build && electron-builder --mac dmg --universal",

    "notarize:dmg": "xcrun notarytool submit dist/*.dmg --apple-id $APPLE_ID --password $APPLE_PASSWORD --team-id $TEAM_ID --wait && xcrun stapler staple dist/*.dmg",

    "upload:mas": "xcrun altool --upload-app --type macos --file dist/mas/*.pkg --username $APPLE_ID --password $APPLE_PASSWORD",

    "release:all": "npm run build:mas && npm run build:dmg && npm run notarize:dmg"
  }
}
```

### 环境变量配置

创建 `.env.local` 文件（**不要提交到 Git**）:

```bash
# Apple Developer 账号
APPLE_ID=your.email@example.com
APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx  # App-specific password

# Team ID (在 developer.apple.com 查看)
TEAM_ID=ABC123DEF4

# 证书标识
CSC_NAME="3rd Party Mac Developer Application: Your Name (ABC123DEF4)"
CSC_INSTALLER_NAME="3rd Party Mac Developer Installer: Your Name (ABC123DEF4)"
```

### CI/CD 配置（GitHub Actions）

创建 `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release-mas:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Import certificates
        env:
          CERTIFICATE_P12: ${{ secrets.CERTIFICATE_P12_BASE64 }}
          CERTIFICATE_PASSWORD: ${{ secrets.CERTIFICATE_PASSWORD }}
        run: |
          echo "$CERTIFICATE_P12" | base64 --decode > certificate.p12
          security create-keychain -p actions build.keychain
          security default-keychain -s build.keychain
          security unlock-keychain -p actions build.keychain
          security import certificate.p12 -k build.keychain -P "$CERTIFICATE_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k actions build.keychain

      - name: Build MAS version
        run: npm run build:mas
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          TEAM_ID: ${{ secrets.TEAM_ID }}

      - name: Upload to App Store Connect
        run: npm run upload:mas
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}

      - name: Build DMG version
        run: npm run build:dmg

      - name: Notarize DMG
        run: npm run notarize:dmg
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          TEAM_ID: ${{ secrets.TEAM_ID }}

      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: release-files
          path: |
            dist/mas/*.pkg
            dist/*.dmg
```

---

## 故障排查

### 常见错误和解决方案

#### 1. 签名验证失败

**错误**:
```
code object is not signed at all
```

**解决方案**:
```bash
# 检查是否所有文件都被签名
find YourApp.app -name "*.node" -exec codesign -dv {} \;

# 重新签名
electron-builder --mac mas --sign
```

#### 2. Provisioning Profile 不匹配

**错误**:
```
Provisioning profile doesn't match the entitlements file
```

**解决方案**:
1. 确保 App ID 的 Capabilities 与 entitlements 一致
2. 重新下载 Provisioning Profile
3. 清理钥匙串中的旧证书

#### 3. 沙箱崩溃

**错误**: 应用启动后立即崩溃

**调试方法**:
```bash
# 查看崩溃日志
log show --predicate 'process == "YourApp"' --last 1h

# 常见原因：
# - 访问了未授权的路径
# - 尝试加载未签名的库
# - entitlements 配置错误
```

**解决方案**:
- 检查 `com.apple.security.files.user-selected.*` entitlements
- 移除所有 `fs.readFileSync()` 的硬编码路径
- 使用 `dialog.showOpenDialog()` 让用户选择文件

#### 4. Native Addon 加载失败

**错误**:
```
Error: dlopen(...): code signature invalid
```

**原因**: `.node` 文件未签名或签名不正确

**解决方案**:
```bash
# 手动签名 native addon
codesign --sign "3rd Party Mac Developer Application: Your Name (TEAMID)" \
  --entitlements build/entitlements.mas.inherit.plist \
  --options runtime \
  --timestamp \
  --force \
  YourApp.app/Contents/Resources/native/fieldcorder_native.node

# 验证
codesign -dv YourApp.app/Contents/Resources/native/fieldcorder_native.node
```

---

## 成本估算

### 一次性成本

| 项目 | 费用 |
|------|------|
| Apple Developer Program | $99/年 |
| 应用图标设计 | $50-200 |
| 截图和宣传图制作 | $100-500 |
| 初次审核时间成本 | 约 2-3 周开发 |

### 持续成本

| 项目 | 费用 |
|------|------|
| Apple Developer 续费 | $99/年 |
| MAS 分成 | 30% 销售额 |
| CDN（DMG 托管） | $10-50/月 |
| 代码签名证书维护 | 包含在 Developer Program |

### 双版本策略收益对比

假设月销量 100 份：

| 指标 | 仅 MAS | 仅 DMG | 双版本 |
|------|--------|--------|--------|
| MAS 销量 | 100 ($29.99) | 0 | 60 ($29.99) |
| DMG 销量 | 0 | 100 ($79.99) | 40 ($79.99) |
| 总收入 | $2,999 | $7,999 | $5,198 |
| Apple 分成 | -$900 | $0 | -$540 |
| 净收入 | $2,099 | $7,999 | $4,658 |

**分析**:
- 仅 DMG 收入最高，但曝光度低
- 双版本策略平衡了收益和用户覆盖
- MAS 可作为"流量入口"，引导用户升级到 Pro

---

## 总结与建议

### 核心结论

1. **AudioUnit/VST 插件加载与 MAS 分发不兼容**
   - MAS 不接受 `com.apple.security.temporary-exception.audio-unit-host`
   - 专业 DAW（Pro Tools、Reaper）都未上架 MAS

2. **推荐采用双版本策略**
   - MAS 版本：内置效果器，面向入门用户
   - DMG 版本：完整插件支持，面向专业用户

3. **技术难点已可解决**
   - Native addon 签名：electron-builder 自动处理
   - Sandbox 限制：条件编译区分版本
   - 证书配置：按照本报告流程操作

### 下一步行动

#### 短期（1-2 周）

1. **决策**: 确认是否上架 MAS
   - 如果是 → 继续
   - 如果否 → 仅准备 DMG 公证流程

2. **创建 Apple Developer 账号**（如未创建）
   - 费用：$99/年
   - 时间：1-2 天审核

3. **创建 Entitlements 文件**
   - `build/entitlements.mas.plist`
   - `build/entitlements.mas.inherit.plist`
   - `build/entitlements.mac.plist`（DMG 版本）

#### 中期（2-4 周）

4. **修改代码支持 Sandbox**
   - 条件编译区分 MAS/DMG
   - 禁用 MAS 版本的插件加载
   - 测试文件访问权限

5. **配置构建流程**
   - 更新 `package.json`
   - 测试本地构建
   - 配置 CI/CD

6. **准备 App Store 素材**
   - 应用描述（中英文）
   - 截图（5 张推荐）
   - 宣传视频（可选）
   - 隐私政策页面

#### 长期（持续迭代）

7. **监控用户反馈**
   - MAS 版本是否满足用户需求
   - 是否有用户询问插件支持
   - 考虑升级到 Pro 的转化率

8. **优化分发策略**
   - 根据数据调整定价
   - 考虑订阅制（MAS 支持内购）
   - 探索企业授权模式

---

## 参考资料

### 官方文档

- [Electron - Mac App Store Submission Guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)
- [Apple - App Sandbox](https://developer.apple.com/documentation/security/app_sandbox)
- [Apple - Entitlement Key Reference](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/)
- [Apple Technical Note TN2312 - Audio Unit Host Sandboxing](https://developer.apple.com/library/archive/technotes/tn2312/_index.html)
- [electron-builder - MAS Configuration](https://www.electron.build/mas.html)
- [electron-builder - MacOS Code Signing](https://www.electron.build/code-signing-mac.html)

### 教程和博客

- [Publishing an Electron App on the Mac App Store](https://samuelmeuli.com/blog/2019-04-09-publishing-an-electron-app-on-the-mac-app-store/)
- [How to Submit an Electron App to the Mac App Store (DoltHub)](https://www.dolthub.com/blog/2024-10-02-how-to-submit-an-electron-app-to-mac-app-store/)
- [Complete Configuration Guide for Electron Applications on MAS](https://www.oreateai.com/blog/complete-configuration-guide-for-electron-applications-on-the-mac-app-store/9966e6c6bbad26547c269deef853b48d)
- [Requesting camera and microphone permission in Electron](https://www.bigbinary.com/blog/request-camera-micophone-permission-electron)

### GitHub Issues 和讨论

- [Electron #24936 - Sandbox breaking the app](https://github.com/electron/electron/issues/24936)
- [Electron #20027 - MAS Private API Rejection](https://github.com/electron/electron/issues/20027)
- [electron-builder #4790 - MAS sandbox crashes](https://github.com/electron-userland/electron-builder/issues/4790)
- [Electron #11479 - Buffer performance in native addon](https://github.com/electron/electron/issues/11479)

### 工具和资源

- [@electron/osx-sign](https://github.com/electron/osx-sign) - Electron macOS 签名工具
- [electron-builder](https://www.electron.build/) - Electron 打包工具
- [Transporter](https://apps.apple.com/app/transporter/id1450874784) - App Store Connect 上传工具
- [App Store Connect](https://appstoreconnect.apple.com/) - 应用管理平台

---

*调研完成时间: 2026-02-16*
*研究员: researcher*
*下次更新: 根据实际实施情况补充*
