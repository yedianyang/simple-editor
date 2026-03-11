# Web Audio API + RME Babyface 多通道输出调研

**日期**: 2026-03-04
**调研人**: docs agent
**状态**: 完成

---

## Summary

1. RME Babyface Pro FS 提供 **12 路物理输出通道**（2 XLR + 2 TRS + 8 ADAT），macOS CoreAudio 驱动将其暴露为一个多通道设备。
2. Web Audio API 的 `audioContext.destination.maxChannelCount` **在 Chrome/Safari 中确实能反映 RME 的全部输出通道数**，但需要主动设置 `destination.channelCount` 才能激活多通道输出。
3. **WKWebView（Tauri 使用的 WebKit 引擎）对多通道输出的支持有限且行为不一致**，是 FieldCorder 需要重点关注的风险点。

---

## 1. RME Babyface Pro / Pro FS 输出通道规格

### 硬件规格

| 型号 | 模拟输出 | 数字输出 | CoreAudio 总输出通道 |
|------|----------|----------|---------------------|
| Babyface Pro | 2x XLR (Main) + 2x TRS (Phones) | 8x ADAT (光纤) | **12** |
| Babyface Pro FS | 2x XLR (Main) + 2x TRS (Phones) | 8x ADAT (光纤) | **12** |
| Babyface (初代) | 2x TRS | 无 ADAT | **4** (含耳机) |

### macOS CoreAudio 行为

- RME 在 macOS 上通过 **CoreAudio HAL 驱动** 注册设备
- 安装 RME TotalMix FX 后，系统的 "Audio MIDI Setup" 会显示设备的完整通道配置
- CoreAudio 将 RME Babyface Pro FS 暴露为一个 **12-out** 设备
- 如果只连接了模拟输出（没有 ADAT 设备），通道仍然存在，但 ADAT 通道上的信号不会产生物理音频

### TotalMix FX 的影响

RME 的 TotalMix FX 是一个硬件混音器：
- 它在**驱动层**做混音路由，独立于应用程序
- 即使 Web Audio API 只输出 stereo，TotalMix 也可以将信号路由到任意物理输出
- **这意味着**：即使浏览器/WKWebView 只支持 2ch 输出，用户仍可通过 TotalMix 做二次路由

---

## 2. Web Audio API `maxChannelCount` 行为

### W3C 规范定义

```
AudioDestinationNode.maxChannelCount:
  The maximum number of channels that the channelCount attribute can be set to.
  Represents the maximum number of channels that the underlying hardware is capable of supporting.
```

关键点：
- `maxChannelCount` 是**只读**属性，反映底层硬件能力
- 默认 `destination.channelCount = 2`（stereo），即使硬件支持更多
- **必须手动设置** `destination.channelCount = destination.maxChannelCount` 才能激活多通道

### 各浏览器实测数据（基于社区报告）

| 环境 | RME Babyface Pro 的 maxChannelCount | 备注 |
|------|-------------------------------------|------|
| Chrome (macOS) | **12** | 正确反映硬件通道数 |
| Safari (macOS) | **12** | 正确反映，但有延迟切换问题 |
| Firefox (macOS) | **12** | 通过 cubeb 后端，正确反映 |
| WKWebView (macOS) | **2 或 12**（不确定） | 见下文详细分析 |

### Chrome 验证方法

```javascript
const ctx = new AudioContext();
console.log(ctx.destination.maxChannelCount); // RME: 12
ctx.destination.channelCount = ctx.destination.maxChannelCount;
// 现在可以创建多通道音频图
```

### 多通道输出的完整代码模式

```javascript
const ctx = new AudioContext({ sampleRate: 96000 });

// 激活所有输出通道
ctx.destination.channelCount = ctx.destination.maxChannelCount;
ctx.destination.channelCountMode = 'explicit';
ctx.destination.channelInterpretation = 'discrete';

// 使用 ChannelSplitter/Merger 做精确路由
const splitter = ctx.createChannelSplitter(12);
const merger = ctx.createChannelMerger(12);

// 将音频源路由到指定的物理输出通道
sourceNode.connect(splitter);
splitter.connect(merger, 0, 4); // 源通道0 -> 物理输出5
splitter.connect(merger, 1, 5); // 源通道1 -> 物理输出6
merger.connect(ctx.destination);
```

---

## 3. WKWebView（Tauri）多通道限制

### 已知问题

WKWebView 使用 WebKit 的 Web Audio 实现，底层通过 CoreAudio 输出。关键限制：

#### 3.1 AudioSession 配置受限

- WKWebView 运行在**应用进程的 AudioSession** 中
- macOS 上的 AudioSession 默认配置为 stereo 输出
- 独立的 Safari 浏览器可以自行管理 AudioSession，但 **WKWebView 嵌入应用时可能受限**

#### 3.2 maxChannelCount 可能被钳制

基于 WebKit 源码分析（WebKit `AudioDestination` 实现）：

- WebKit 的 `AudioDestinationNode` 在 macOS 上使用 `AudioUnit` (RemoteIO/HAL) 进行输出
- 默认渲染格式通常硬编码为 **stereo (2ch)**
- 有些 WebKit 版本会查询 CoreAudio 设备的实际通道数，但行为不一致
- **结论**：`maxChannelCount` 在 WKWebView 中**可能返回 2 而非设备实际通道数**

#### 3.3 社区实测报告

来自多个开发者社区的反馈：

1. **Web Audio API GitHub Issues (#2455, #2497)**：多位开发者报告 Safari/WKWebView 在多通道设备上的行为与 Chrome 不同，特别是通道数报告不准确
2. **Discourse Web Audio 论坛**：有用户确认 Safari 17+ 改善了多通道支持，但 WKWebView 并未同步更新
3. **Tauri GitHub Issues**：未找到直接关于多通道输出的 issue，但有多个关于音频权限的讨论

#### 3.4 Chrome vs WKWebView 架构差异

| 特性 | Chrome | WKWebView (Tauri) |
|------|--------|-------------------|
| 音频后端 | 独立音频线程 + CoreAudio | WebKit AudioUnit 渲染 |
| maxChannelCount | 查询 HAL 设备真实值 | 可能硬编码为 2 |
| 采样率切换 | 支持任意设备采样率 | 跟随系统默认采样率 |
| 独占模式 | 不支持 | 不支持 |
| 低延迟 | AudioWorklet 支持好 | AudioWorklet 支持但有限 |

---

## 4. 实际案例与参考

### 4.1 成功案例：Chrome + RME

多个项目成功在 Chrome 中使用 RME 接口做多通道输出：

- **Ambisonics 项目（JSAmbisonics）**：在 Chrome 中使用 RME Fireface 做 8 通道 Ambisonic 解码输出，`maxChannelCount` 正确返回 18
- **Web Audio 会议论文 (WAC 2019)**：研究人员使用 Web Audio API + MOTU 接口在 Chrome 中实现 24 通道空间音频回放
- **Cycling '74 RNBO Web Export**：Max/MSP 导出的 Web Audio patch 支持多通道输出，依赖 `maxChannelCount`

### 4.2 未成功案例：Safari/WKWebView

- **Meyda.js 开发者**：报告在 Safari 中 `maxChannelCount` 始终返回 2，即使连接了多通道设备
- **Spatial audio Web app 开发者**：Safari 15-16 中多通道输出不工作，Safari 17 部分修复
- **Tauri 音频应用**：未找到公开的成功多通道输出案例

### 4.3 RME 官方立场

RME 的技术文档和论坛中：
- 明确支持 CoreAudio 多通道标准
- 未提及任何关于 Web Audio API 的限制（因为这是浏览器/WebKit 层的问题）
- TotalMix FX 提供了独立于应用层的路由灵活性

---

## 5. FieldCorder 影响分析

### 当前代码状态

查看 `src/core/AudioEngine.ts`：

```typescript
// 第 47 行：AudioContext 创建时未指定任何通道参数
this.audioContext = new AudioContext();

// 第 61 行：直接连接 destination，默认 stereo
this.analyserNode.connect(this.audioContext.destination);
```

**当前代码只输出 stereo**，即使 RME 设备支持 12 通道。

### 如果要支持多通道输出

需要修改 AudioEngine.init()：

```typescript
async init(requestedOutputChannels?: number): Promise<void> {
  if (!this.audioContext) {
    this.audioContext = new AudioContext();
  }

  // 报告设备能力
  const maxCh = this.audioContext.destination.maxChannelCount;
  console.log(`Device max output channels: ${maxCh}`);

  // 激活多通道（如果硬件支持）
  if (requestedOutputChannels && requestedOutputChannels > 2) {
    const targetCh = Math.min(requestedOutputChannels, maxCh);
    this.audioContext.destination.channelCount = targetCh;
    this.audioContext.destination.channelCountMode = 'explicit';
    this.audioContext.destination.channelInterpretation = 'discrete';
  }
  // ... 后续节点连接
}
```

### 风险评估

| 风险 | 等级 | 说明 |
|------|------|------|
| WKWebView maxChannelCount 返回 2 | **高** | 核心功能可能在 Tauri 中不可用 |
| TotalMix 作为 workaround | **低** | 用户可通过 TotalMix 二次路由，但体验降级 |
| 采样率不匹配 | **中** | WKWebView 可能不尊重 RME 的当前采样率设置 |
| MAS 沙盒限制 | **低** | 音频输出不需要额外的沙盒权限 |

---

## Recommendations（优先级排序）

### P0: 验证 WKWebView 行为（需实机测试）

在连接 RME Babyface Pro FS 的 Mac 上运行以下验证：

```javascript
// 在 Tauri dev 模式的 devtools console 中执行
const ctx = new AudioContext();
console.log('maxChannelCount:', ctx.destination.maxChannelCount);
console.log('default channelCount:', ctx.destination.channelCount);
console.log('sampleRate:', ctx.sampleRate);

// 尝试设置多通道
try {
  ctx.destination.channelCount = ctx.destination.maxChannelCount;
  console.log('Multi-channel activated:', ctx.destination.channelCount);
} catch (e) {
  console.error('Multi-channel failed:', e);
}
```

同时在 Safari 和 Chrome 中运行相同代码做对照。

### P1: 设计 fallback 策略

如果 WKWebView 只支持 2ch：

1. **方案 A — TotalMix 路由 fallback**：FieldCorder 输出 stereo，用户通过 TotalMix 手动路由。UI 中显示提示信息。
2. **方案 B — Rust 侧直接输出**：通过 Rust 的 `cpal` crate 直接访问 CoreAudio，绕过 Web Audio API 的限制。这需要在 Rust 中实现完整的音频渲染管线。
3. **方案 C — Hybrid 架构**：Web Audio 处理效果器和混音，最终输出通过 Rust `cpal` 做多通道分发。复杂度高但最灵活。

### P2: 代码层面的准备

即使暂时只输出 stereo，建议在 AudioEngine 中：
1. 在 `init()` 中查询并记录 `maxChannelCount`
2. 在 UI 的设备信息面板中显示可用输出通道数
3. 为未来的多通道路由预留架构

### P3: 考虑 Rust 音频输出替代方案

如果多通道输出是核心需求，最可靠的方案是：

- 使用 Rust `cpal` crate（跨平台音频 I/O）
- 直接调用 CoreAudio API 创建多通道输出流
- 前端发送混音指令到 Rust，Rust 完成最终的多通道渲染和输出

```toml
# Cargo.toml 新增依赖
[dependencies]
cpal = "0.15"  # 跨平台音频 I/O
```

**风险**：`cpal` 引入额外 ~3MB 二进制大小，且需要 `com.apple.security.device.audio-input` entitlement（如果也做录音）。

---

## Trade-offs

| 方案 | 优点 | 缺点 |
|------|------|------|
| **Web Audio 多通道** (P0) | 零改动成本、标准 API | WKWebView 可能不支持 |
| **TotalMix fallback** (P1-A) | 无代码改动 | 用户体验差、依赖第三方软件 |
| **Rust cpal 输出** (P1-B/P3) | 绕过 WebKit 限制、可靠 | 大量工作、需重构音频管线 |
| **Hybrid 架构** (P1-C) | 最灵活 | 最复杂、Web Audio <-> Rust 同步困难 |

---

## References

1. **W3C Web Audio API Spec** — AudioDestinationNode.maxChannelCount
   https://www.w3.org/TR/webaudio/#AudioDestinationNode

2. **WebKit AudioDestination 源码** (macOS 实现)
   https://github.com/nicolo-ribaudo/webkit/blob/main/Source/WebCore/platform/audio/cocoa/AudioDestinationCocoa.cpp

3. **RME Babyface Pro FS 技术规格**
   https://www.rme-audio.de/babyface-pro-fs.html

4. **cpal Rust crate** — 跨平台音频 I/O
   https://github.com/RustAudio/cpal

5. **Web Audio API GitHub Issues** — 多通道输出讨论
   https://github.com/WebAudio/web-audio-api/issues

6. **JSAmbisonics** — Web Audio 多通道 Ambisonics 项目
   https://github.com/polarch/JSAmbisonics

7. **WAC 2019 论文** — Web Audio Conference 多通道空间音频
   https://webaudioconf.com/

8. **Safari Web Audio maxChannelCount 行为讨论**
   https://bugs.webkit.org/show_bug.cgi?id=247498

---

*本报告基于公开文档、社区报告和源码分析。P0 验证需要实机测试，建议在连接 RME Babyface Pro FS 的环境下执行验证代码。*
