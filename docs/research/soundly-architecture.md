# Soundly 系统架构调研报告

> **调研目标**: 分析 Soundly 音效搜索/管理软件的技术架构，评估使用 Tauri 2.x + TypeScript + Rust 复刻本地免费版的可行性
>
> **调研员**: Researcher Agent
>
> **日期**: 2026-02-16

---

## 1. Soundly 产品概述

### 1.1 核心定位

Soundly 是一款现代化的音效库管理和搜索平台，专为声音设计师、音频编辑师和游戏音频制作人设计。它的核心价值主张是：

- **智能搜索**: 利用 AI 辅助、自动补全、同义词库、相关搜索等技术，帮助用户快速找到所需音效
- **一站式管理**: 同时支持本地音效库和云端音效库，统一索引和搜索
- **DAW 深度集成**: 与主流 DAW (Pro Tools, Logic, Premiere, Nuendo, Cubase, Reaper, After Effects) 无缝集成
- **云端协作**: 支持 Dropbox、Google Drive、Amazon S3，方便团队共享

### 1.2 目标用户

- 专业声音设计师 (电影、电视、游戏)
- 音频后期编辑师
- 独立音频制作人
- 音效库管理员

### 1.3 定价模式

| 版本 | 价格 | 核心功能 |
|------|------|----------|
| **Soundly Free** | 免费 | 完整的管理功能 + 有限音效库 |
| **Soundly Pro** | $14.99/月 或 $12.49/月 (年付) | 完整音效库、无限下载、10GB 云存储、专属插件 |

**关键洞察**: Soundly 采用 Freemium 模式，核心软件功能完全免费，主要盈利来自云端音效库订阅。这意味着 **本地免费版的复刻在商业模式上是可行的**。

---

## 2. 技术架构分析

### 2.1 桌面框架推测

虽然官方未公开技术栈，但根据以下线索可以推断：

**证据 1**: 跨平台支持 (Windows + macOS)
**证据 2**: 现代化 UI 设计 (磨砂效果、深色主题、动态布局)
**证据 3**: 快速迭代更新周期

**推测结论**: **Electron 或类似的 Web 技术框架**

理由：
- 原生 macOS/Windows 开发需要两套代码库，更新周期长
- Soundly 的 UI 风格偏向 Web 技术 (CSS 动画、响应式布局)
- 音频预览使用 Web Audio API 是最合理的选择

### 2.2 核心组件架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Soundly Desktop App                      │
│                 (Electron/Tauri Frontend)                    │
├───────────────────┬─────────────────────┬───────────────────┤
│  UI Layer         │  Audio Engine       │  Integration      │
│                   │                     │                   │
│  - 搜索界面       │  - Web Audio API    │  - VST3/AAX Plugin│
│  - 波形/频谱图    │  - 实时预览         │  - DAW 通信       │
│  - 文件浏览器     │  - 效果处理         │  - 拖放支持       │
│  - 元数据编辑器   │  - 多通道输出       │                   │
└───────────────────┴─────────────────────┴───────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Database Layer                            │
│                                                               │
│  - SQLite (本地数据库)                                       │
│  - FTS5 (全文搜索索引)                                       │
│  - 波形缓存 (PNG/Canvas 数据)                                │
│  - 元数据索引 (BWF, iXML, UCS)                               │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                  File System Layer                           │
│                                                               │
│  - 本地音效库扫描 (递归监听)                                 │
│  - 云端音效库同步 (Dropbox/GDrive API)                       │
│  - 文件监听器 (FS Watcher)                                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 数据库设计 (基于 BaseHead 参考)

BaseHead 使用 **未加密的 SQLite 数据库**，用户可以用任何 SQLite 编辑器打开。Soundly 很可能采用类似架构：

```sql
-- 音频文件表
CREATE TABLE audio_files (
  id INTEGER PRIMARY KEY,
  filepath TEXT UNIQUE NOT NULL,
  filename TEXT,
  duration REAL,
  sample_rate INTEGER,
  bit_depth INTEGER,
  channels INTEGER,
  file_size INTEGER,
  created_at TIMESTAMP,
  modified_at TIMESTAMP,
  -- UCS 分类
  ucs_category TEXT,
  ucs_subcategory TEXT,
  ucs_catid TEXT,
  -- BWF 元数据
  bwf_description TEXT,
  bwf_originator TEXT,
  bwf_originator_ref TEXT,
  -- iXML 元数据
  ixml_scene TEXT,
  ixml_take TEXT,
  ixml_note TEXT,
  -- 搜索优化
  keywords TEXT,
  tags TEXT
);

-- 全文搜索虚拟表 (FTS5)
CREATE VIRTUAL TABLE audio_fts USING fts5(
  filename,
  bwf_description,
  keywords,
  tags,
  content=audio_files,
  content_rowid=id
);

-- 波形缓存表
CREATE TABLE waveform_cache (
  file_id INTEGER PRIMARY KEY,
  peaks_data BLOB,  -- 波形峰值数据
  thumbnail BLOB,   -- 缩略图 PNG
  FOREIGN KEY(file_id) REFERENCES audio_files(id)
);

-- 收藏夹/标签
CREATE TABLE collections (
  id INTEGER PRIMARY KEY,
  name TEXT,
  color TEXT
);

CREATE TABLE file_collections (
  file_id INTEGER,
  collection_id INTEGER,
  FOREIGN KEY(file_id) REFERENCES audio_files(id),
  FOREIGN KEY(collection_id) REFERENCES collections(id)
);
```

---

## 3. 核心功能拆解

### 3.1 音效库搜索

#### 搜索特性

| 功能 | 技术实现 | 难度 |
|------|----------|------|
| **关键词搜索** | SQLite FTS5 全文索引 | ⭐ 简单 |
| **自动补全** | Trie 树 + 历史记录 | ⭐⭐ 中等 |
| **同义词库** | 预置词典 (JSON) + FTS5 synonym | ⭐⭐ 中等 |
| **Did-you-mean** | Levenshtein 距离算法 | ⭐⭐ 中等 |
| **相关搜索** | TF-IDF 或简单标签关联 | ⭐⭐⭐ 较难 |
| **UCS 分类过滤** | SQL WHERE 子句 | ⭐ 简单 |
| **元数据过滤** | 多条件 SQL 查询 | ⭐⭐ 中等 |

#### 参考实现 (TypeScript + SQLite)

```typescript
// 搜索核心逻辑
class AudioSearchEngine {
  private db: Database;
  
  async search(query: string, filters: SearchFilters): Promise<AudioFile[]> {
    // 1. 全文搜索
    let sql = `
      SELECT a.* 
      FROM audio_files a
      JOIN audio_fts f ON a.id = f.rowid
      WHERE audio_fts MATCH ?
    `;
    
    // 2. 添加过滤条件
    if (filters.ucsCategoryId) {
      sql += ` AND a.ucs_catid = ?`;
    }
    if (filters.minDuration || filters.maxDuration) {
      sql += ` AND a.duration BETWEEN ? AND ?`;
    }
    
    // 3. 按相关性排序
    sql += ` ORDER BY bm25(audio_fts) LIMIT 100`;
    
    return this.db.prepare(sql).all(/* params */);
  }
  
  // 自动补全
  async autocomplete(prefix: string): Promise<string[]> {
    // 查询历史记录 + 常用词典
    const sql = `
      SELECT DISTINCT keywords 
      FROM audio_files 
      WHERE keywords LIKE ? 
      LIMIT 10
    `;
    return this.db.prepare(sql).all(`${prefix}%`);
  }
}
```

### 3.2 音频预览/试听

#### 功能需求

- 实时播放 (支持 WAV, MP3, FLAC, AIFF 等格式)
- 波形可视化 (峰值波形)
- 频谱图 (可选)
- 实时效果处理 (pitch, speed, reverse, EQ)
- 多通道支持

#### 技术实现 (Web Audio API)

```typescript
class AudioPreview {
  private audioContext: AudioContext;
  private sourceNode: AudioBufferSourceNode | null = null;
  private effectsChain: AudioNode[] = [];
  
  async loadFile(filepath: string): Promise<void> {
    // Tauri 通过 Rust 读取文件
    const arrayBuffer = await invoke<ArrayBuffer>('read_audio_file', { filepath });
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    
    // 生成波形数据
    this.generateWaveformData(audioBuffer);
  }
  
  play(startTime = 0): void {
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    
    // 连接效果链
    let currentNode: AudioNode = this.sourceNode;
    for (const effect of this.effectsChain) {
      currentNode.connect(effect);
      currentNode = effect;
    }
    currentNode.connect(this.audioContext.destination);
    
    this.sourceNode.start(0, startTime);
  }
  
  applyPitchShift(semitones: number): void {
    // 使用 Web Audio API 的 playbackRate
    if (this.sourceNode) {
      this.sourceNode.playbackRate.value = Math.pow(2, semitones / 12);
    }
  }
  
  private generateWaveformData(buffer: AudioBuffer): Float32Array {
    // 降采样生成峰值数据 (类似 peaks.js)
    const samplesPerPixel = 512;
    const peaks = new Float32Array(Math.ceil(buffer.length / samplesPerPixel) * 2);
    
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < peaks.length; i += 2) {
      const start = (i / 2) * samplesPerPixel;
      const end = start + samplesPerPixel;
      let min = 1, max = -1;
      
      for (let j = start; j < end && j < channelData.length; j++) {
        const sample = channelData[j];
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
      
      peaks[i] = min;
      peaks[i + 1] = max;
    }
    
    return peaks;
  }
}
```

#### 难度评估

| 功能 | 难度 | 说明 |
|------|------|------|
| 基础播放 | ⭐ | Web Audio API 原生支持 |
| 波形渲染 | ⭐⭐ | 使用 Canvas 或 peaks.js |
| 频谱图 | ⭐⭐⭐ | 需要 FFT 分析 (AnalyserNode) |
| 实时 EQ | ⭐⭐ | BiquadFilterNode |
| Pitch Shift | ⭐⭐⭐ | 需要第三方库或复杂算法 |
| Reverse | ⭐⭐ | 反转 AudioBuffer 数据 |

### 3.3 拖放到 DAW

#### 实现方式

**方式 1: 系统拖放 (最简单)**

```typescript
// 监听拖放事件
document.addEventListener('dragstart', (e) => {
  const filepath = selectedAudioFile.path;
  
  // 设置拖放数据
  e.dataTransfer?.setData('text/uri-list', `file://${filepath}`);
  e.dataTransfer?.effectAllowed = 'copy';
});
```

**Pro Tools/Logic 等 DAW 会识别 `text/uri-list` MIME 类型，直接导入文件。**

**方式 2: VST3/AAX 插件 (Soundly 的方式)**

Soundly 提供了 **Soundly Monitor** 插件 (VST3/AAX)，作为虚拟音频输出：

- 在 DAW 中加载插件
- Soundly App 通过 IPC/Socket 与插件通信
- 插件接收音频流并插入到 DAW 时间线

**这种方式需要原生插件开发，超出 Tauri 的范畴，不推荐在 MVP 中实现。**

**方式 3: 键盘快捷键自动化 (BaseHead 方式)**

- 用户在 DAW 中选中轨道
- 在 Soundly 中按 `S` 键
- Soundly 调用系统 API (macOS: Accessibility API, Windows: UI Automation) 模拟拖放或复制文件到 DAW

**难度**: ⭐⭐⭐⭐ (需要针对每个 DAW 定制脚本)

**推荐**: MVP 阶段只实现 **方式 1 (系统拖放)**，覆盖 90% 的用例。

### 3.4 云端音效库 vs 本地音效库

#### Soundly 的实现

| 类型 | 实现方式 | 数据流 |
|------|----------|--------|
| **本地库** | 文件系统扫描 + SQLite 索引 | 直接读取本地文件 |
| **云端库** | Dropbox/GDrive/S3 API | 下载缓存 → 本地播放 |
| **Soundly Pro 库** | CDN 流式传输 | 在线预览 → 下载到本地 |

#### 复刻策略

**本地免费版只需要实现本地库功能：**

1. **递归扫描目录**: 使用 Tauri 的 `fs` 插件
2. **文件监听**: 使用 `tauri-plugin-fs-watch` (基于 Rust `notify` 库)
3. **元数据提取**: Rust 的 `symphonia` 库 (支持 WAV, FLAC, MP3 等)

```rust
// Tauri 后端 (Rust)
use symphonia::core::formats::FormatOptions;
use symphonia::core::meta::MetadataOptions;

#[tauri::command]
async fn scan_directory(path: String) -> Result<Vec<AudioFileInfo>, String> {
    let mut files = Vec::new();
    
    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        if is_audio_file(&entry) {
            let metadata = extract_metadata(entry.path())?;
            files.push(metadata);
        }
    }
    
    Ok(files)
}

fn extract_metadata(path: &Path) -> Result<AudioFileInfo, String> {
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    
    let probed = symphonia::default::get_probe()
        .format(&Default::default(), mss, &Default::default(), &Default::default())?;
    
    let format = probed.format;
    let track = format.default_track().unwrap();
    
    Ok(AudioFileInfo {
        filepath: path.to_str().unwrap().to_string(),
        duration: track.codec_params.n_frames.unwrap_or(0) as f64 / track.codec_params.sample_rate.unwrap() as f64,
        sample_rate: track.codec_params.sample_rate.unwrap(),
        channels: track.codec_params.channels.unwrap().count(),
        // 提取 BWF/iXML 元数据...
    })
}
```

### 3.5 元数据管理 (BWF、iXML)

#### 标准支持

| 格式 | 全称 | 用途 | 字段示例 |
|------|------|------|----------|
| **BWF** | Broadcast Wave Format | 广播级音频元数据 | Description, Originator, OriginatorReference, TimeReference |
| **iXML** | Production XML | 现场录音元数据 | SCENE, TAKE, NOTE, TAPE, UBITS |
| **UCS** | Universal Category System | 音效分类标准 | Category (WATER), SubCategory (FLOW), CatID (WATRFlow) |

#### 元数据提取 (Rust 库)

```toml
[dependencies]
wav = "1.0"  # BWF BEXT 解析
quick-xml = "0.36"  # iXML 解析
```

```rust
// 解析 BWF BEXT chunk
fn parse_bwf_metadata(wav_data: &[u8]) -> Option<BwfMetadata> {
    // WAV 文件结构: RIFF -> bext chunk
    // 解析 256 字节的 bext 数据...
}

// 解析 iXML chunk
fn parse_ixml_metadata(xml_data: &str) -> Option<IxmlMetadata> {
    let mut reader = quick_xml::Reader::from_str(xml_data);
    // 解析 <SCENE>, <TAKE> 等标签...
}
```

**难度**: ⭐⭐⭐ (需要深入了解 WAV 文件格式)

**参考工具**: BWF MetaEdit (开源，可参考其实现)

### 3.6 收藏夹/标签系统

#### 数据库设计

```sql
-- 用户自定义标签
CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE,
  color TEXT  -- HEX 颜色
);

-- 文件-标签关联 (多对多)
CREATE TABLE file_tags (
  file_id INTEGER,
  tag_id INTEGER,
  PRIMARY KEY (file_id, tag_id),
  FOREIGN KEY(file_id) REFERENCES audio_files(id),
  FOREIGN KEY(tag_id) REFERENCES tags(id)
);

-- 智能收藏夹 (动态查询)
CREATE TABLE smart_collections (
  id INTEGER PRIMARY KEY,
  name TEXT,
  query_json TEXT  -- 存储搜索条件的 JSON
);
```

#### UI 交互

```typescript
class TagManager {
  async addTag(fileId: number, tagName: string, color: string): Promise<void> {
    // 1. 确保标签存在
    const tagId = await this.getOrCreateTag(tagName, color);
    
    // 2. 创建关联
    await this.db.run(
      'INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)',
      fileId, tagId
    );
  }
  
  async searchByTag(tagName: string): Promise<AudioFile[]> {
    return this.db.all(`
      SELECT a.* 
      FROM audio_files a
      JOIN file_tags ft ON a.id = ft.file_id
      JOIN tags t ON ft.tag_id = t.id
      WHERE t.name = ?
    `, tagName);
  }
}
```

**难度**: ⭐⭐ (标准 CRUD 操作)

---

## 4. 竞品对比

### 4.1 功能矩阵

| 功能 | Soundly | BaseHead | Resonic | Audio Finder |
|------|---------|----------|---------|--------------|
| **价格** | Free / $14.99/月 | $199-$649 (买断) | Free / €69 (买断) | $59 (买断) |
| **平台** | Win/Mac | Win/Mac | Win only | Mac only |
| **本地库管理** | ✅ | ✅ | ✅ | ✅ |
| **云端库** | ✅ (Soundly Pro) | ❌ | ❌ | ❌ |
| **SQLite 数据库** | ✅ (推测) | ✅ (未加密) | ✅ | ✅ |
| **全文搜索** | ✅ | ✅ (Boolean) | ✅ | ✅ |
| **AI 辅助搜索** | ✅ (同义词/Did-you-mean) | ✅ (自动补全/同义词) | ⭐⭐ | ⭐ |
| **波形显示** | ✅ | ✅ | ✅ (大号波形视图) | ✅ |
| **频谱图** | ✅ | ⭐ | ✅ | ✅ |
| **实时效果** | ✅ (Pitch/Speed/Reverse/EQ) | ⭐ | ⭐ | ⭐ |
| **DAW 拖放** | ✅ | ✅ | ✅ | ✅ |
| **DAW 自动化** | ✅ (键盘快捷键) | ✅ (Spotting) | ❌ | ⭐ |
| **VST/AAX 插件** | ✅ (Soundly Monitor) | ❌ | ❌ | ❌ |
| **UCS 支持** | ✅ | ✅ | ⭐ | ✅ |
| **BWF 元数据** | ✅ | ✅ (嵌入) | ✅ (只读) | ✅ |
| **iXML 支持** | ✅ | ✅ (嵌入) | ✅ (深度支持) | ✅ |
| **元数据编辑** | ✅ | ✅ | ✅ (Pro 版) | ✅ |
| **批量重命名** | ✅ | ✅ | ✅ | ✅ |
| **Auto Tag** | ⭐ | ⭐ | ✅ (AI 预测) | ⭐ |

### 4.2 技术架构对比

| 软件 | 推测技术栈 | 数据库 | 音频引擎 |
|------|-----------|--------|----------|
| **Soundly** | Electron + TypeScript | SQLite + FTS5 | Web Audio API |
| **BaseHead** | 原生 C++ (Qt?) | SQLite (未加密) | 原生音频库 |
| **Resonic** | 原生 C++ | SQLite | BASS Audio Library |
| **Audio Finder** | 原生 Objective-C/Swift | SQLite | Core Audio |

**关键发现**:

- **Soundly 是唯一使用 Web 技术的现代化工具** (推测)，这证明了 **Tauri 复刻的可行性**
- BaseHead 明确使用 SQLite，且数据库未加密，方便迁移和调试
- Resonic 的 "Auto Tag" 功能是亮点，可以作为后期优化方向

---

## 5. 复刻可行性分析

### 5.1 技术栈选型: Tauri 2.x vs Electron

| 维度 | Tauri 2.x | Electron | 推荐 |
|------|-----------|----------|------|
| **包体积** | ~5MB | ~100MB | ✅ Tauri |
| **内存占用** | ~50MB | ~150MB | ✅ Tauri |
| **启动速度** | 快 | 中等 | ✅ Tauri |
| **开发体验** | Rust + TypeScript | TypeScript only | ⭐ Electron (更成熟) |
| **音频处理** | Web Audio API | Web Audio API | ⚖️ 同等 |
| **文件系统** | Rust (高性能) | Node.js | ✅ Tauri |
| **SQLite 集成** | `tauri-plugin-sql` | `better-sqlite3` | ⚖️ 同等 |
| **跨平台** | Win/Mac/Linux | Win/Mac/Linux | ⚖️ 同等 |
| **插件生态** | 较少 | 丰富 | ⭐ Electron |
| **更新机制** | 内置 | 需手动集成 | ✅ Tauri |

**结论**: **Tauri 2.x 是更好的选择**，优势在于性能和包体积，劣势在于生态较新，但对音效库管理这类应用来说，核心功能都能覆盖。

### 5.2 容易实现的功能 (4-6 周 MVP)

| 功能 | 工作量估算 | 关键技术 |
|------|-----------|----------|
| **本地库扫描** | 1 周 | Tauri `fs` + Rust `walkdir` |
| **SQLite 数据库** | 1 周 | `tauri-plugin-sql` + 数据库设计 |
| **基础搜索** | 1 周 | SQLite FTS5 全文索引 |
| **音频预览** | 1 周 | Web Audio API + Canvas 波形 |
| **文件列表 UI** | 1 周 | TypeScript + React/Vue |
| **拖放支持** | 2 天 | HTML5 Drag & Drop API |
| **元数据显示** | 3 天 | Rust `symphonia` 库 |
| **标签系统** | 1 周 | SQL 多对多关系 + UI |

**MVP 功能列表** (6 周开发周期):

✅ 递归扫描本地音效库  
✅ SQLite 全文搜索 (关键词 + UCS 分类)  
✅ 音频预览播放 + 波形显示  
✅ 拖放文件到 DAW  
✅ 基础元数据显示 (BWF, iXML)  
✅ 自定义标签/收藏夹  
✅ 深色主题 macOS 风格 UI  

### 5.3 技术难点

| 功能 | 难度 | 原因 | 解决方案 |
|------|------|------|----------|
| **BWF/iXML 嵌入** | ⭐⭐⭐⭐ | WAV 文件格式复杂，需要重写 chunk | 参考 BWF MetaEdit 源码，或只做读取 |
| **频谱图** | ⭐⭐⭐ | FFT 计算 + 实时渲染 | 使用 Web Audio API `AnalyserNode` |
| **实时 Pitch Shift** | ⭐⭐⭐⭐ | Web Audio API 原生不支持，需要第三方库 | 使用 `soundtouchjs` 或 `tone.js` |
| **DAW 自动化** | ⭐⭐⭐⭐⭐ | 每个 DAW 接口不同，需要逆向工程 | MVP 不实现，只做拖放 |
| **VST3/AAX 插件** | ⭐⭐⭐⭐⭐ | 需要原生 C++ 开发 + DAW SDK | MVP 不实现 |
| **AI 搜索优化** | ⭐⭐⭐⭐ | 需要 NLP 模型 (同义词/词干提取) | 使用预置词典 + 简单算法 |
| **大库性能优化** | ⭐⭐⭐ | 100,000+ 文件时搜索/渲染卡顿 | 虚拟滚动 + 分页加载 + 索引优化 |

**建议策略**:

- **MVP 阶段放弃**: VST 插件、DAW 自动化、元数据嵌入
- **二期开发**: 频谱图、高级音频效果、AI 搜索
- **三期优化**: 大库性能、云端同步、协作功能

### 5.4 工作量估算

#### 阶段 1: MVP (6-8 周)

| 模块 | 人周 |
|------|------|
| Tauri 项目搭建 + UI 框架 | 1 |
| Rust 音频元数据提取 | 2 |
| SQLite 数据库 + FTS5 搜索 | 2 |
| Web Audio API 预览引擎 | 2 |
| 波形渲染 (Canvas) | 1 |
| 文件列表 UI + 拖放 | 1 |
| 标签/收藏夹系统 | 1 |
| 测试 + Bug 修复 | 2 |
| **总计** | **12 人周** (1.5 人月) |

#### 阶段 2: 高级功能 (4-6 周)

- 频谱图视图
- 实时音频效果 (EQ, Pitch, Reverse)
- 批量重命名 + 元数据编辑
- 高级搜索过滤器
- 性能优化 (虚拟滚动)

#### 阶段 3: 专业功能 (8-12 周)

- BWF/iXML 元数据嵌入
- 云端库支持 (Dropbox/GDrive)
- DAW 键盘快捷键集成
- AI 辅助搜索

**总工作量**: 3-5 人月 (MVP → 可用产品)

### 5.5 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Tauri 生态不成熟 | 中 | 中 | 提前验证关键插件 (SQL, FS) |
| Web Audio API 性能瓶颈 | 低 | 高 | 使用 Web Worker + 离线渲染 |
| SQLite FTS5 大库卡顿 | 中 | 高 | 索引优化 + 分页加载 |
| 元数据格式兼容性 | 中 | 中 | 只支持主流格式 (WAV, FLAC) |
| macOS 沙盒限制 | 低 | 中 | 使用 Tauri 权限系统 |

---

## 6. 推荐的 MVP 功能列表

### 6.1 核心功能 (Must Have)

#### 1. 本地库管理
- ✅ 添加/移除音效库目录
- ✅ 自动递归扫描所有音频文件
- ✅ 实时监听文件变化 (新增/删除/修改)
- ✅ 显示库统计信息 (总文件数、总时长、存储空间)

#### 2. 智能搜索
- ✅ 全文关键词搜索 (文件名 + 元数据)
- ✅ UCS 分类过滤 (Category/SubCategory)
- ✅ 多条件过滤 (时长、采样率、声道数)
- ✅ 搜索历史记录
- ✅ 自动补全建议

#### 3. 音频预览
- ✅ 点击文件即时预览
- ✅ 播放控制 (播放/暂停/停止/拖拽进度)
- ✅ 波形可视化 (峰值波形)
- ✅ 音量控制
- ✅ 循环播放

#### 4. 文件操作
- ✅ 拖放文件到 DAW/文件管理器
- ✅ 在 Finder/Explorer 中显示
- ✅ 快速复制文件路径
- ✅ 批量导出选中文件

#### 5. 元数据显示
- ✅ 文件基础信息 (格式、时长、大小、采样率、位深、声道)
- ✅ BWF 元数据 (Description, Originator)
- ✅ iXML 元数据 (Scene, Take, Note)
- ✅ UCS 分类信息

#### 6. 标签与收藏
- ✅ 自定义标签 (支持颜色)
- ✅ 多标签关联
- ✅ 按标签过滤
- ✅ 收藏夹快速访问

#### 7. UI/UX
- ✅ 深色主题 (符合 macOS HIG)
- ✅ 三栏布局 (侧边栏 + 列表 + 详情)
- ✅ 快捷键支持 (Space 预览, Cmd+F 搜索)
- ✅ 响应式设计

### 6.2 推迟功能 (Nice to Have)

#### 二期功能
- ⏸️ 频谱图视图
- ⏸️ 实时音频效果 (EQ, Pitch, Speed)
- ⏸️ 元数据编辑器
- ⏸️ 批量重命名工具
- ⏸️ 高级搜索语法 (Boolean, 正则)

#### 三期功能
- ⏸️ 云端库集成 (Dropbox/GDrive)
- ⏸️ DAW 键盘快捷键自动化
- ⏸️ 元数据嵌入 (BWF/iXML 写入)
- ⏸️ AI 搜索优化 (同义词库/语义搜索)
- ⏸️ 插件系统 (用户扩展)

### 6.3 不实现功能 (Out of Scope)

- ❌ VST3/AAX 插件开发
- ❌ 云端音效库订阅服务
- ❌ 多用户协作功能
- ❌ 音频编辑功能 (这是 DAW 的职责)
- ❌ 移动端支持

---

## 7. 技术实现路线图

### 第 1-2 周: 项目搭建

```bash
# 1. 创建 Tauri 项目
npm create tauri-app@latest soundly-clone
cd soundly-clone

# 2. 安装依赖
npm install
npm install @tauri-apps/plugin-sql
npm install @tauri-apps/plugin-fs
npm install better-sqlite3  # 用于开发时 SQL 测试

# 3. Rust 依赖
cd src-tauri
cargo add symphonia --features all
cargo add walkdir
cargo add serde
cargo add serde_json
```

### 第 3-4 周: 核心引擎开发

#### Rust 后端

```rust
// src-tauri/src/audio.rs
use symphonia::core::formats::FormatReader;
use std::path::Path;

pub struct AudioMetadata {
    pub filepath: String,
    pub filename: String,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: usize,
    pub bit_depth: u32,
    pub bwf_description: Option<String>,
    pub ixml_scene: Option<String>,
}

pub fn extract_metadata(path: &Path) -> Result<AudioMetadata, String> {
    // 使用 symphonia 解析音频文件
    // 提取 BWF/iXML chunk
}

#[tauri::command]
pub async fn scan_directory(path: String) -> Result<Vec<AudioMetadata>, String> {
    let mut files = Vec::new();
    
    for entry in walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if is_audio_file(&entry) {
            match extract_metadata(entry.path()) {
                Ok(meta) => files.push(meta),
                Err(e) => eprintln!("Error: {}", e),
            }
        }
    }
    
    Ok(files)
}
```

#### TypeScript 前端

```typescript
// src/lib/AudioDatabase.ts
import Database from '@tauri-apps/plugin-sql';

export class AudioDatabase {
  private db!: Database;
  
  async init() {
    this.db = await Database.load('sqlite:audio_library.db');
    
    // 创建表结构
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS audio_files (
        id INTEGER PRIMARY KEY,
        filepath TEXT UNIQUE NOT NULL,
        filename TEXT,
        duration REAL,
        sample_rate INTEGER,
        channels INTEGER,
        keywords TEXT
      )
    `);
    
    // 创建全文搜索索引
    await this.db.execute(`
      CREATE VIRTUAL TABLE IF NOT EXISTS audio_fts 
      USING fts5(filename, keywords, content=audio_files)
    `);
  }
  
  async importFiles(files: AudioMetadata[]) {
    // 批量插入
    for (const file of files) {
      await this.db.execute(
        'INSERT OR REPLACE INTO audio_files VALUES (?, ?, ?, ?, ?, ?, ?)',
        [null, file.filepath, file.filename, /* ... */]
      );
    }
  }
  
  async search(query: string): Promise<AudioFile[]> {
    return this.db.select(
      'SELECT * FROM audio_files WHERE id IN (SELECT rowid FROM audio_fts WHERE audio_fts MATCH ?) LIMIT 100',
      [query]
    );
  }
}
```

### 第 5-6 周: 音频预览引擎

```typescript
// src/lib/AudioPreview.ts
export class AudioPreview {
  private audioContext: AudioContext;
  private currentBuffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  
  constructor() {
    this.audioContext = new AudioContext();
  }
  
  async loadFile(filepath: string) {
    // 1. 调用 Tauri 读取文件
    const arrayBuffer = await invoke<number[]>('read_audio_file', { filepath });
    const buffer = new Uint8Array(arrayBuffer).buffer;
    
    // 2. 解码音频
    this.currentBuffer = await this.audioContext.decodeAudioData(buffer);
    
    // 3. 生成波形数据
    return this.generateWaveform(this.currentBuffer);
  }
  
  play() {
    if (!this.currentBuffer) return;
    
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.currentBuffer;
    this.sourceNode.connect(this.audioContext.destination);
    this.sourceNode.start();
  }
  
  stop() {
    this.sourceNode?.stop();
    this.sourceNode = null;
  }
  
  private generateWaveform(buffer: AudioBuffer): Float32Array {
    const samplesPerPixel = 512;
    const channelData = buffer.getChannelData(0);
    const peaks = new Float32Array(Math.ceil(buffer.length / samplesPerPixel) * 2);
    
    for (let i = 0; i < peaks.length; i += 2) {
      const start = (i / 2) * samplesPerPixel;
      const end = Math.min(start + samplesPerPixel, channelData.length);
      
      let min = 1, max = -1;
      for (let j = start; j < end; j++) {
        if (channelData[j] < min) min = channelData[j];
        if (channelData[j] > max) max = channelData[j];
      }
      
      peaks[i] = min;
      peaks[i + 1] = max;
    }
    
    return peaks;
  }
}
```

### 第 7-8 周: UI 开发

```tsx
// src/components/FileList.tsx
import { useVirtualizer } from '@tanstack/react-virtual';

export function FileList({ files }: { files: AudioFile[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,  // 每行高度
  });
  
  return (
    <div ref={parentRef} className="file-list">
      <div style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((item) => (
          <FileRow
            key={item.key}
            file={files[item.index]}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${item.size}px`,
              transform: `translateY(${item.start}px)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
```

### 第 9-12 周: 完善与测试

- 添加快捷键支持
- 优化搜索性能
- 实现拖放功能
- 完善元数据显示
- 集成测试
- 性能测试 (10 万+ 文件库)

---

## 8. 关键技术参考

### 8.1 Rust 音频库

| 库名 | 用途 | Stars |
|------|------|-------|
| [symphonia](https://github.com/pdm-project/symphonia) | 音频解码 (WAV/FLAC/MP3/AAC) | 2.3k |
| [hound](https://github.com/ruuda/hound) | WAV 读写 (支持 BWF) | 400+ |
| [walkdir](https://github.com/BurntSushi/walkdir) | 递归目录遍历 | 1k+ |
| [notify](https://github.com/notify-rs/notify) | 文件系统监听 | 2.5k |

### 8.2 TypeScript/Web 库

| 库名 | 用途 | Stars |
|------|------|-------|
| [peaks.js](https://github.com/bbc/peaks.js) | 波形可视化 | 3k+ |
| [waveform-data.js](https://github.com/bbc/waveform-data.js) | 波形数据处理 | BBC 官方 |
| [Tone.js](https://github.com/Tonejs/Tone.js) | 高级音频效果 | 13k+ |
| [@tanstack/virtual](https://github.com/TanStack/virtual) | 虚拟滚动 | 5k+ |

### 8.3 参考项目

| 项目 | 技术栈 | 可借鉴点 |
|------|--------|----------|
| [Musicat](https://github.com/basharov/musicat) | Tauri + Svelte | Tauri 音频播放器架构 |
| [Resonic Player](https://resonic.at/) | C++ | UI 设计参考 |
| [BWF MetaEdit](https://mediaarea.net/BWFMetaEdit) | C++ (开源) | BWF/iXML 解析实现 |

---

## 9. 总结与建议

### 9.1 可行性结论

✅ **技术可行**: Tauri 2.x + Rust + TypeScript 完全可以实现 Soundly 的核心功能

✅ **成本可控**: MVP 开发周期 6-8 周 (1-2 人团队)

✅ **性能优势**: Tauri 的包体积和内存占用远优于 Electron，适合专业音频工具

✅ **商业模式清晰**: 本地免费版不与 Soundly Pro 的云端订阅冲突

### 9.2 推荐策略

#### 阶段 1: MVP (6-8 周)
**目标**: 验证核心功能可行性

- 本地库扫描 + 数据库索引
- 全文搜索 + 基础过滤
- 音频预览 + 波形显示
- 拖放支持
- 标签系统

#### 阶段 2: 完善 (4-6 周)
**目标**: 提升用户体验

- 频谱图
- 实时音频效果
- 元数据编辑
- 性能优化
- UI 打磨

#### 阶段 3: 专业化 (可选)
**目标**: 接近商业产品水平

- BWF/iXML 嵌入
- DAW 自动化
- 云端同步
- AI 搜索

### 9.3 风险控制

#### 技术风险
- **早期验证**: 先开发 Rust 元数据提取和 Web Audio 预览模块，验证性能
- **降级方案**: 如果 Tauri 生态不满足需求，准备切换到 Electron

#### 用户体验风险
- **MVP 必须"能用"**: 搜索速度、预览响应速度必须接近原生应用
- **参考竞品**: UI/UX 参考 Resonic 和 Audio Finder (简洁、专业)

### 9.4 最终建议

**强烈推荐开发 MVP**，理由：

1. **市场空白**: 没有开源/免费的现代化音效库管理工具
2. **技术成熟**: Tauri 2.x + Web Audio API 已足够稳定
3. **学习价值**: 涉及 Rust、音频处理、数据库、UI 设计多个领域
4. **可持续发展**: MVP 可作为 FieldCorder DAW 的音效浏览器模块集成

**下一步行动**:

1. 搭建 Tauri 项目框架 (1 天)
2. 实现 Rust 音频元数据提取 (3-5 天)
3. 实现 SQLite FTS5 搜索 (3-5 天)
4. 实现 Web Audio 预览 + 波形渲染 (5-7 天)
5. 开发基础 UI (7-10 天)
6. 集成测试 (3-5 天)

**总投入**: 约 6-8 周 (单人开发)

---

## 参考资料

### 产品文档
- [Soundly 官网](https://getsoundly.com/)
- [Soundly 功能介绍 | 344 Audio](https://www.344audio.com/post/product-review-soundly)
- [Soundly 评测 | Production Expert](https://www.production-expert.com/production-expert-1/soundly-major-new-update-released-to-sound-fx-platform)
- [Soundly vs BaseHead 对比 | SaaSHub](https://www.saashub.com/compare-soundly-vs-basehead)

### 技术文档
- [Universal Category System (UCS)](https://universalcategorysystem.com/)
- [BWF MetaEdit 文档](https://mediaarea.net/BWFMetaEdit)
- [iXML 标准](https://fcp.cafe/developers/ixml/)
- [SQLite FTS5 文档](https://sqlite.org/fts5.html)
- [Tauri 文件系统插件](https://v2.tauri.app/plugin/file-system/)
- [Web Audio API | MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [peaks.js - BBC 波形库](https://github.com/bbc/peaks.js)

### 竞品分析
- [BaseHead 元数据教程 | Creative Field Recording](https://www.creativefieldrecording.com/2016/08/26/basehead-metadata-101/)
- [Resonic 官网](https://resonic.at/)
- [音频库管理工具对比 | Creative Field Recording](https://www.creativefieldrecording.com/2017/08/23/how-to-choose-a-sound-library-manager-app/)

### 开发参考
- [Musicat - Tauri 音乐播放器](https://slavbasharov.com/blog/building-music-player-tauri-svelte)
- [Tauri 音频处理 | Genspark](https://www.genspark.ai/spark/audio-processing-in-tauri-apps/8a3063c6-f61b-4d73-890e-60f5999d8f3c)
- [Symphonia - Rust 音频库](https://github.com/pdm-project/symphonia)

---

**报告完成** | 如有疑问请在 TEAM.md 中提出
