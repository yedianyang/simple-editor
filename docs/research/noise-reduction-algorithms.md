# 降噪算法调研报告

**调研时间**: 2026-03-03
**调研员**: docs
**项目**: FieldCorder DAW

---

## Summary

1. 对于 FieldCorder 的 Tauri + Web Audio 架构，**实时降噪**最实际的路线是在 AudioWorkletNode 中运行纯 JS/WASM 的频域处理（频谱门限或频谱减法），延迟可控制在 ~23ms（1024-sample FFT @44.1kHz）。
2. **高质量 ML 降噪**（RNNoise、DeepFilterNet）不适合做实时 insert plugin——SharedArrayBuffer 在 WKWebView 不可用，且 WASM-GRU 模型在 AudioWorklet 128-sample 回调窗口内的时间预算极紧。但编译为 WASM 后可作为**近实时离线处理**（非 insert，而是 destructive apply），或编译为 Rust 原生离线处理。
3. **推荐首期实现两个插件**：(A) Spectral Gate（实时 insert，纯 TS/AudioWorklet），(B) RNNoise-WASM offline apply（通过 Tauri command 调用 Rust `nnnoiseless` crate）。

---

## 目录

1. [架构约束分析](#架构约束分析)
2. [实时算法评估](#实时算法评估)
   - 2.1 频谱减法 (Spectral Subtraction)
   - 2.2 频谱门限 (Spectral Gating)
   - 2.3 维纳滤波 (Wiener Filter)
   - 2.4 轻量 ML (WASM-based)
3. [离线/近实时算法评估](#离线近实时算法评估)
   - 3.1 RNNoise
   - 3.2 DeepFilterNet
   - 3.3 传统频谱降噪 + 噪声 profile
4. [实现可行性矩阵](#实现可行性矩阵)
5. [推荐方案](#推荐方案)
6. [Trade-offs](#trade-offs)
7. [参考资料](#参考资料)

---

## 架构约束分析

在评估算法之前，必须理解 FieldCorder 的架构对降噪插件施加的硬约束。

### Web Audio 实时路径

```
AudioBufferSource → TrackGain → CrossfaderGain → InsertIn → [Plugin Chain] → InsertOut → Pan → Analyser → Master
```

当前 `PluginHost.ts` 的 builtin 插件（EQ、Compressor 等）全部使用 **原生 Web Audio 节点**（BiquadFilterNode、DynamicsCompressorNode），不涉及自定义 DSP 代码。

降噪算法需要自定义 DSP（FFT、频域操作），因此必须用 **AudioWorkletNode** 或已废弃的 ScriptProcessorNode。

### AudioWorkletNode 的约束

| 约束 | 值 | 影响 |
|------|-----|------|
| render quantum | 128 samples | 每次回调只处理 128 samples |
| 回调周期 @48kHz | ~2.67ms | 所有 DSP 必须在这个窗口内完成 |
| 回调周期 @96kHz | ~1.33ms | 更紧张 |
| SharedArrayBuffer | **不可用** (WKWebView) | 不能用 SAB 做 JS↔Rust 实时桥接 |
| MessagePort | 可用（有拷贝开销） | 可用于参数更新、非实时数据传递 |
| WASM in Worklet | 可用 | 可在 Worklet 中加载 WASM 模块 |

### 关键结论

- **实时 insert plugin** 必须完全在 AudioWorklet 线程内完成（纯 JS 或 WASM）
- **Rust 后端** 只能用于离线/destructive 处理（通过 Tauri IPC 发送整段 PCM，处理完返回）
- FFT-based 算法需要 hop-size 缓冲（典型 1024 samples），引入 ~23ms 额外延迟
- 多通道环境录音（4-6ch, 96kHz）对实时算法的 CPU 负载压力是单声道的 4-6 倍

---

## 实时算法评估

### 2.1 频谱减法 (Spectral Subtraction)

#### 原理

1. 在安静片段采集噪声 profile（平均噪声频谱幅度 |N(f)|）
2. 对每一帧信号做 FFT → 从幅度谱中减去噪声谱 → IFFT
3. `|Y(f)| = max(|X(f)| - alpha * |N(f)|, beta * |N(f)|)`
4. 其中 alpha 是过减系数，beta 是频谱下限（防止 "musical noise"）

#### 计算开销

- FFT-1024: ~50us per frame (JS), ~10us (WASM)
- 总体每帧: FFT + 频谱操作 + IFFT ≈ 150us (JS) / 30us (WASM)
- 每秒 @48kHz (hop=512): ~94 帧/秒 → 14ms/s (JS) / 2.8ms/s (WASM)
- **结论**: 单声道完全可行，6声道 JS 勉强，6声道 WASM 轻松

#### 延迟

- FFT-1024 + 50% overlap → 1024 samples latency = **21.3ms @48kHz**
- 可接受用于混音监听，不适合实时演奏监听

#### 音质

- **语音**: 良好（经典语音增强方法）
- **环境录音**: 中等。对稳态噪声（hiss、hum、风扇）有效。对非稳态噪声（风声突发、交通）效果差
- **已知问题**: Musical noise（金属感伪影），需要通过 oversubtraction + spectral floor 缓解
- **对田野录音的适用性**: 适合处理底噪/设备噪声，不适合处理风声和交通突发声

#### 实现可行性

- **纯 TypeScript**: 可行。需自行实现 FFT（或用 fft.js 库）
- **WASM**: 用 Rust `rustfft` crate 编译为 WASM，性能提升 5x
- **参考实现**:
  - [speex preprocessor](https://www.speex.org/) — C 实现，包含频谱减法
  - [noisereduce](https://github.com/timsainb/noisereduce) — Python，清晰的教学实现
  - [fft.js](https://github.com/nicedoc/fft.js) — 纯 JS FFT 库

#### 所需参数（UI）

- Noise Threshold / Reduction Amount (dB)
- Noise Profile (用户选择安静片段采样)
- Smoothing (时间平滑因子)
- Spectral Floor (beta，防止 musical noise)

---

### 2.2 频谱门限 (Spectral Gating)

#### 原理

1. 对每帧做 FFT
2. 对每个频率 bin 独立应用 gate：低于阈值的 bin 衰减（而非完全静音）
3. 阈值可以是固定值，也可以从噪声 profile 动态获取
4. 比频谱减法更简单，伪影更少

```
for each bin k:
  if |X(k)| < threshold(k):
    Y(k) = X(k) * attenuation   // e.g. 0.01 (-40dB)
  else:
    Y(k) = X(k)
```

可加入 attack/release 包络使 gate 开关更平滑。

#### 计算开销

- 与频谱减法几乎相同（FFT + 逐 bin 比较 + IFFT）
- 比频谱减法略低，因为没有减法后的 floor 操作
- **结论**: 6 声道 @48kHz 用 WASM 完全可行

#### 延迟

- 同频谱减法: **~21ms @48kHz** (FFT-1024)

#### 音质

- **环境录音**: 比频谱减法更好。伪影更少（不产生 musical noise）
- **风噪**: 低频 gate 可有效抑制持续性风噪
- **嗡声 (hum)**: 对 50/60Hz 及谐波非常有效
- **嘶声 (hiss)**: 高频 gate 非常有效
- **局限**: 对宽带非稳态噪声（如交通、人群）效果有限

#### 实现可行性

- **最容易实现**：算法简单，代码量小
- **FieldCorder 集成**：可作为 AudioWorkletNode，与现有 plugin chain 直接串联
- **参考实现**:
  - [Audacity Noise Gate](https://manual.audacityteam.org/man/noise_gate.html) — 开源实现参考
  - [sox noisered](https://sox.sourceforge.net/sox.html) — SOX 的频谱降噪

#### 所需参数（UI）

- Threshold (dB) — 全局或按频段
- Reduction (dB) — gate 关闭时的衰减量
- Attack (ms) — gate 打开速度
- Release (ms) — gate 关闭速度
- Frequency Range — 可选：仅对特定频段生效
- Noise Profile — 可选：从选区学习噪声

---

### 2.3 维纳滤波 (Wiener Filter)

#### 原理

1. 估算信号和噪声的功率谱密度（PSD）
2. 计算最优滤波器：`H(f) = P_signal(f) / (P_signal(f) + P_noise(f))`
3. 应用：`Y(f) = H(f) * X(f)`
4. 本质是"信噪比加权"——SNR 高的频率保留，SNR 低的衰减

#### 计算开销

- FFT + PSD 估算 + 滤波器计算 + IFFT
- 比频谱减法/门限稍高（多了 PSD 平滑和滤波器更新）
- 但仍在实时预算内（@48kHz 单声道 JS 约 200us/帧）

#### 延迟

- 同上: **~21ms @48kHz**

#### 音质

- **理论最优**: 在噪声和信号独立且高斯的假设下，维纳滤波是 MSE 意义上的最优线性滤波器
- **实际表现**: 比频谱减法好（更平滑，伪影更少），但不如 ML 方法
- **环境录音**: 对稳态噪声效果很好。噪声 PSD 估计的准确度是关键
- **风噪**: 中等（风噪非高斯，违反假设）

#### 实现可行性

- **中等难度**: 需要实现 PSD 估算（可用递归平均 + 最小值追踪）
- **参考实现**:
  - [webrtc-noise-suppression](https://chromium.googlesource.com/external/webrtc/+/refs/heads/main/modules/audio_processing/ns/) — WebRTC 内置降噪，包含维纳滤波
  - [OMLSA](https://www.eng.biu.ac.il/gannMDw/speech-enhancement/) — Optimally-Modified Log-Spectral Amplitude estimator

#### 所需参数（UI）

- Noise Reduction Strength (dB)
- Noise Profile (从选区学习)
- Smoothing Factor (PSD 平滑时间常数)

---

### 2.4 轻量 ML 方法 (WASM)

#### 方案 A: RNNoise 编译为 WASM

RNNoise（下文 3.1 详述）可编译为 WASM 在 AudioWorklet 中运行。

- **模型大小**: ~85KB（GRU 权重）
- **计算**: 每 10ms 帧需 ~1.5ms CPU (WASM, M1 Mac)
- **问题**: 仅支持 48kHz 单声道。多通道需多实例。96kHz 需先重采样。
- **延迟**: 10ms（帧大小）+ 重采样延迟
- **可行性**: 技术上可行但有风险。AudioWorklet 回调 128 samples @48kHz = 2.67ms，而 RNNoise 处理 480 samples（10ms），需要跨多个回调累积帧。CPU 预算紧。

**结论**: 可以尝试，但多通道 @96kHz 时 CPU 可能不够。建议先作为离线处理，验证可行后再尝试实时。

#### 方案 B: 自训练小型 CNN/GRU

- 训练一个针对环境录音噪声的小型模型（如 3层 GRU, 64 hidden units）
- 用 ONNX → WASM 部署（onnxruntime-web）
- **问题**: onnxruntime-web WASM 约 8MB，AudioWorklet 中加载可能有初始化延迟
- **结论**: 过于复杂，不适合首期实现

---

## 离线/近实时算法评估

这些算法通过 Tauri IPC 调用 Rust 后端，对整段/选区音频做 destructive 处理。用户体验类似 Audacity 的 "Effect → Noise Reduction"。

### 3.1 RNNoise

#### 原理

Mozilla 开发的基于 RNN 的实时噪声抑制：
1. 输入 10ms 帧（480 samples @48kHz）
2. 计算 22 个 Bark 频段的特征
3. 通过 3 层 GRU（Gate Recurrent Unit）网络预测每个频段的增益
4. 对信号频谱应用增益 → 输出降噪后的信号
5. 不需要噪声 profile 采集——模型已学会区分语音和噪声

#### 计算开销

- **C 原版**: ~1.5ms per 10ms frame (M1 Mac, single core)
- **Rust (nnnoiseless)**: 同级别，可能更快（SIMD）
- **WASM**: ~2-3ms per 10ms frame
- 处理 1 分钟音频 @48kHz 单声道: ~0.9 秒 (Rust native)

#### 音质

- **语音**: 非常好。这是其设计目标（VoIP 场景）
- **环境录音**: 中等偏好。对以下有效：
  - 风扇/空调嗡声 ---- 极好
  - 持续性交通背景噪 ---- 好
  - 电气 hiss ---- 好
  - 偶发风噪 ---- 中等
- **局限**:
  - 模型训练数据偏向语音——会把某些环境声当作"信号"保留，或把某些想保留的声音当噪声移除
  - 仅支持 48kHz 单声道。96kHz 需重采样，多声道需逐通道处理
  - 模型固定，不能针对特定噪声做微调

#### 实现可行性

**Rust crate: `nnnoiseless`**
- 地址: https://github.com/jneem/nnnoiseless
- 纯 Rust 重写的 RNNoise，no-std 兼容
- 许可: BSD-3-Clause（MAS 友好）
- Cargo.toml 新增: `nnnoiseless = "0.5"`
- 代码量: 约 50 行 Rust + Tauri command wrapper
- **风险**: 新 crate 依赖。`nnnoiseless` 维护活跃度中等（最后更新 2024），但代码成熟稳定

```rust
// 伪代码示例
use nnnoiseless::DenoiseState;

#[tauri::command]
fn denoise_audio(samples: Vec<f32>, sample_rate: u32) -> Result<Vec<f32>, String> {
    // 如果不是 48kHz，需要先重采样
    let mut state = DenoiseState::new();
    let mut output = Vec::with_capacity(samples.len());
    for chunk in samples.chunks(DenoiseState::FRAME_SIZE) {
        let mut frame = [0.0f32; DenoiseState::FRAME_SIZE];
        frame[..chunk.len()].copy_from_slice(chunk);
        let mut out = [0.0f32; DenoiseState::FRAME_SIZE];
        state.process_frame(&mut out, &frame);
        output.extend_from_slice(&out[..chunk.len()]);
    }
    Ok(output)
}
```

#### 田野录音适用性评估

| 噪声类型 | 效果 | 备注 |
|----------|------|------|
| 设备底噪 / preamp hiss | 极好 | 稳态噪声，RNNoise 强项 |
| 空调/风扇 hum | 极好 | 同上 |
| 持续交通背景 | 好 | 低频隆隆声被有效抑制 |
| 间歇风噪 | 中等 | 突发性噪声跟踪有延迟 |
| 鸟鸣/虫鸣（想保留的） | 差 | 可能被当作噪声移除 |
| 人群杂音 | 差 | 与语音频谱重叠，模型难以区分 |

---

### 3.2 DeepFilterNet

#### 原理

更先进的 DNN 降噪方案（2022 年发布）：
1. 双阶段架构：ERB 频段增益预测 + 复数频谱精细化
2. 比 RNNoise 模型更大（~2.4MB vs ~85KB），但质量明显更好
3. 支持 full-band（48kHz 全频段处理）

#### 计算开销

- **Rust 原版**: ~5-8ms per 10ms frame (M1 Mac)
- 处理 1 分钟 @48kHz 单声道: ~3-5 秒 (Rust native)
- WASM: 可能 2-3x 慢于 native → 不适合实时

#### 音质

- **语音**: 极好。在多个 benchmark 上超越 RNNoise
- **环境录音**: 好。保留更多信号细节
- **风噪**: 比 RNNoise 更好
- **局限**: 同样偏向语音训练数据

#### 实现可行性

**Rust crate: `deep-filter`**
- 地址: https://github.com/Rikorose/DeepFilterNet
- 许可: MIT / Apache-2.0（MAS 友好）
- **问题**:
  - 依赖 ONNX Runtime 或 tract 做推理
  - 模型文件 ~2.4MB 需要打包进 app bundle
  - 集成复杂度远高于 nnnoiseless
  - ONNX Runtime 的 Rust 绑定 (`ort` crate) 会增加约 30-50MB 二进制体积
- Cargo.toml: `deep-filter = { git = "https://github.com/Rikorose/DeepFilterNet" }` （无 crates.io 发布）
- **风险**: 高。依赖链深，构建复杂，且没有稳定的 crates.io 发布

**结论**: Phase 2 或更后再考虑。首期用 RNNoise 足够。

---

### 3.3 传统频谱降噪 + 噪声 Profile（Rust 离线版）

#### 原理

与 2.1/2.2 相同的算法，但在 Rust 中实现离线版本：
1. 用户选择安静片段 → Rust 端计算噪声 profile（平均功率谱）
2. 对全文件/选区做 STFT → 频谱减法/维纳滤波 → ISTFT
3. 返回处理后的 PCM 数据

#### 计算开销

- Rust FFT (`rustfft` crate): ~2us per 1024-point FFT
- 处理 1 分钟 @48kHz 单声道: ~0.3 秒
- 6 通道: ~1.8 秒

#### 音质

- 与 2.1-2.3 相同，但可以做多 pass 处理提升质量
- 支持更大的 FFT size（4096/8192）提高频率分辨率
- 可以做前向+后向处理（acausal，零延迟效果）

#### 实现可行性

- `rustfft` crate: 成熟、零依赖、MAS 友好 (MIT/Apache-2.0)
- Cargo.toml: `rustfft = "6"`
- 代码量: ~200 行 Rust
- **风险**: 低。`rustfft` 是 Rust 生态中最成熟的 FFT 库

---

## 实现可行性矩阵

| 算法 | 实时 insert | 离线 apply | 实现难度 | 音质（环境录音） | 新依赖 | 推荐 |
|------|:-----------:|:----------:|:--------:|:----------------:|:------:|:----:|
| Spectral Gate (JS/WASM) | OK | -- | 低 | 中 | fft.js 或 WASM FFT | **Phase 1** |
| Spectral Subtraction (JS/WASM) | OK | -- | 低-中 | 中 | 同上 | Phase 1 可选 |
| Wiener Filter (JS/WASM) | OK | -- | 中 | 中-好 | 同上 | Phase 2 |
| RNNoise-WASM 实时 | 风险高 | -- | 中-高 | 好 | rnnoise WASM | Phase 2 |
| RNNoise Rust 离线 | -- | OK | 低 | 好 | `nnnoiseless` | **Phase 1** |
| DeepFilterNet Rust 离线 | -- | OK | 高 | 很好 | `deep-filter` + `ort` | Phase 3 |
| Spectral Denoise Rust 离线 | -- | OK | 中 | 中-好 | `rustfft` | Phase 1 可选 |

---

## 推荐方案

### Phase 1 (首期): 两个互补的降噪工具

#### A. Spectral Gate — 实时 Insert Plugin

**理由**: 最简单、风险最低、对田野录音最实用的实时方案。

- **实现**: AudioWorkletNode + 纯 TypeScript（或 WASM FFT）
- **算法**: 频谱门限，支持可选的噪声 profile
- **注册**: 在 `PluginHost.ts` 中新增 `builtin:spectral-gate`
- **参数**:
  - Threshold (-60 to 0 dB)
  - Reduction (-60 to 0 dB)
  - Attack (0.1 to 50 ms)
  - Release (1 to 500 ms)
  - Learn Noise (button, 从播放位置前采集 0.5s 噪声)
- **预期代码量**: ~300 行 AudioWorklet processor + ~100 行 PluginHost 集成
- **延迟**: ~21ms (1024-sample FFT @48kHz)
- **工时**: 3-5 天

**集成点**: 在 `PluginHost.BUILTIN_PLUGINS` 新增条目，`createBuiltinInstance()` 中创建 AudioWorkletNode 并注册 processor。

```typescript
// PluginHost.ts 新增
{
  id: 'builtin:spectral-gate',
  name: 'Spectral Gate',
  path: '',
  type: 'effect',
  format: 'WebAudio',
  category: 'Noise Reduction',
  vendor: 'FieldCorder',
}
```

```typescript
// spectral-gate-processor.ts (AudioWorkletProcessor)
class SpectralGateProcessor extends AudioWorkletProcessor {
  // 内部维护 ring buffer (1024 samples)
  // 每凑齐一个 FFT 帧就处理
  // FFT → 逐 bin 门限 → IFFT → overlap-add 输出
}
```

#### B. RNNoise 离线处理 — Rust Tauri Command

**理由**: 最高质量的通用降噪，且集成极简（一个 crate + 一个 command）。

- **实现**: Rust `nnnoiseless` crate + Tauri command
- **UI 交互**: 用户选择选区 → 点击 "Denoise (AI)" → 进度条 → 替换选区音频
- **集成**: 新增 Tauri command `denoise_rnnoise`，前端通过 `invoke()` 调用
- **多通道**: 逐通道处理，每通道独立 DenoiseState
- **96kHz 支持**: 需要先 downsample 到 48kHz → 处理 → upsample 回 96kHz
- **预期代码量**: ~80 行 Rust + ~60 行 TS 调用层
- **工时**: 2-3 天

**Cargo.toml 新增**:
```toml
nnnoiseless = "0.5"
```

**风险评估**: `nnnoiseless` 是纯 Rust、no_std 兼容、BSD-3 许可。无系统依赖、无 C FFI。对 MAS 沙盒无影响。唯一风险是维护频率较低，但代码已稳定（RNNoise 算法本身不变）。

### Phase 2 (后续)

1. **Wiener Filter 实时 insert** — 比 Spectral Gate 更精细，但需要 PSD 追踪
2. **RNNoise WASM 实时** — 在 AudioWorklet 中运行 nnnoiseless 的 WASM 编译版
3. **Rust 频谱降噪离线** — 用 `rustfft` 实现传统频谱减法/维纳滤波，支持噪声 profile

### Phase 3 (远期)

1. **DeepFilterNet 离线** — 更高质量的 ML 降噪
2. **自定义训练模型** — 针对环境录音场景（鸟鸣保留、风噪移除）的专用模型

---

## Trade-offs

### 实时 vs 离线

| 方面 | 实时 Insert | 离线 Apply |
|------|------------|------------|
| 用户体验 | 边听边调，即时反馈 | 需要等待处理完成 |
| 算法复杂度 | 受限（必须 <2.67ms/128样本） | 不受限（可用任何算法） |
| 音质上限 | 中等（轻量算法） | 高（可用 ML 模型） |
| Undo 集成 | 无需（非 destructive） | 需要 undo 支持（destructive） |
| 多通道 @96kHz | CPU 压力大 | 无实时约束，可并行处理 |

### Spectral Gate vs Spectral Subtraction

| 方面 | Spectral Gate | Spectral Subtraction |
|------|--------------|---------------------|
| 伪影 | 更少（无 musical noise） | 更多（需要 floor 参数调节） |
| 效果 | 较保守（偏向保留信号） | 更激进（可深度降噪） |
| 实现难度 | 更简单 | 稍复杂（需要 oversubtraction） |
| 参数调节 | 更直观（threshold + reduction） | 需要经验（alpha, beta 参数） |

### RNNoise vs 传统频谱降噪

| 方面 | RNNoise | 传统频谱降噪 |
|------|---------|-------------|
| 噪声 profile | 不需要（自适应） | 需要用户选择安静片段 |
| 稳态噪声 | 极好 | 好 |
| 非稳态噪声 | 中-好 | 差 |
| 音频保真度 | 可能过度处理非语音信号 | 可通过参数精确控制 |
| 计算成本 | 较高 | 较低 |
| 模型固定性 | 固定模型，不可调 | 参数完全可调 |

### AudioWorkletNode vs ScriptProcessorNode

| 方面 | AudioWorkletNode | ScriptProcessorNode |
|------|-----------------|-------------------|
| 线程模型 | 独立音频线程（不阻塞主线程） | 主线程（阻塞 UI） |
| 浏览器支持 | 现代浏览器 + WKWebView | 所有（但已废弃） |
| 性能 | 更好 | 较差，尤其多通道 |
| WASM 支持 | 可在 Worklet 中加载 | 不可（主线程） |
| **推荐** | **是** | 否（仅 fallback） |

---

## 参考资料

### 算法与论文

- Boll, S.F. (1979). "Suppression of acoustic noise in speech using spectral subtraction." IEEE TASSP. — 频谱减法经典论文
- Valin, J.M. (2018). "A Hybrid DSP/Deep Learning Approach to Real-Time Full-Band Speech Enhancement." arXiv:1709.08243 — RNNoise 原论文
- Schroter, H. et al. (2022). "DeepFilterNet: A Low Complexity Speech Enhancement Framework." INTERSPEECH. — DeepFilterNet 论文
- Ephraim, Y. & Malah, D. (1984). "Speech enhancement using a minimum mean-square error short-time spectral amplitude estimator." IEEE TASSP. — 维纳滤波/MMSE 经典

### 开源实现

- [RNNoise](https://github.com/xiph/rnnoise) — Mozilla/Xiph.org, BSD-3, C 实现
- [nnnoiseless](https://github.com/jneem/nnnoiseless) — Rust 重写 RNNoise, BSD-3
- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) — Rust + Python, MIT/Apache-2.0
- [rustfft](https://github.com/ejmahler/RustFFT) — 纯 Rust FFT, MIT/Apache-2.0
- [fft.js](https://github.com/nicedoc/fft.js) — 纯 JS FFT
- [Audacity Noise Reduction](https://github.com/audacity/audacity/blob/master/src/effects/NoiseReduction.cpp) — GPL，参考实现

### Web Audio 参考

- [MDN AudioWorkletProcessor](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor)
- [Google Chrome Labs: Audio Worklet Design Pattern](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webaudio/AudioWorkletDesignPattern.md)
- [WebAssembly in AudioWorklet](https://web.dev/audio-worklet-design-pattern/#wasm-audio-worklet) — WASM 在 Worklet 中的最佳实践

### 竞品参考

- **iZotope RX**: 行业标准降噪。使用频谱门限 + ML 混合方案。提供 "Learn" 按钮采集噪声 profile，处理参数包括 Reduction、Sensitivity、Frequency Smoothing、Time Smoothing
- **Audacity**: Noise Reduction effect 使用频谱减法 + 维纳滤波混合。两步流程：Step 1 = Get Noise Profile, Step 2 = Apply
- **Adobe Audition**: Adaptive Noise Reduction（实时）+ Noise Reduction (process)。实时版用自适应滤波，离线版用频谱减法

---

*调研完成时间: 2026-03-03*
*研究员: docs*
