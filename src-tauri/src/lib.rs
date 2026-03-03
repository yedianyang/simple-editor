use std::fs;
use std::path::PathBuf;
use tauri::ipc::{Request, Response};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem};
use tauri::Emitter;

// ── File Dialog Commands ──────────────────────────────────────────

/// Open file dialog with audio format filters. Returns selected file paths.
#[tauri::command]
async fn open_file_dialog(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let paths = app
        .dialog()
        .file()
        .add_filter("Audio Files", &["wav", "aif", "aiff", "flac", "mp3", "ogg"])
        .add_filter("All Files", &["*"])
        .set_title("Open Audio Files")
        .blocking_pick_files();

    match paths {
        Some(files) => Ok(files
            .iter()
            .filter_map(|f| f.as_path().map(|p| p.to_string_lossy().to_string()))
            .collect()),
        None => Ok(vec![]),
    }
}

/// Save file dialog. Returns selected path or empty string if cancelled.
#[tauri::command]
async fn save_file_dialog(
    app: tauri::AppHandle,
    default_name: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app
        .dialog()
        .file()
        .add_filter("WAV Audio", &["wav"])
        .add_filter("All Files", &["*"])
        .set_title("Save Audio File");

    if let Some(name) = default_name {
        builder = builder.set_file_name(&name);
    }

    match builder.blocking_save_file() {
        Some(path) => Ok(path.as_path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()),
        None => Ok(String::new()),
    }
}

// ── File System Commands ──────────────────────────────────────────

/// Read a file as binary bytes. Returns Vec<u8> → ArrayBuffer in JS.
/// For small-to-medium files (project files, configs, etc.).
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

/// Read a file as UTF-8 text.
#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

/// Write binary bytes to a file. Auto-creates parent directories.
#[tauri::command]
fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories for '{}': {}", path, e))?;
    }
    fs::write(&path, &contents).map_err(|e| format!("Failed to write '{}': {}", path, e))
}

/// Write binary data to a file via raw IPC (no JSON serialization overhead).
/// The file path is passed in the `x-file-path` request header.
/// Binary body is received directly as raw bytes.
/// Returns the number of bytes written for verification.
#[tauri::command]
fn write_binary_file(request: Request<'_>) -> Result<u64, String> {
    let path = request
        .headers()
        .get("x-file-path")
        .ok_or("Missing x-file-path header")?
        .to_str()
        .map_err(|e| format!("Invalid path header: {}", e))?
        .to_string();

    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Expected raw binary body, got JSON".into());
        }
    };

    let dest = PathBuf::from(&path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories for '{}': {}", path, e))?;
    }

    fs::write(&dest, bytes)
        .map_err(|e| format!("Failed to write '{}': {}", path, e))?;

    let meta = fs::metadata(&dest)
        .map_err(|e| format!("Failed to stat '{}' after write: {}", path, e))?;

    Ok(meta.len())
}

/// Get file metadata (size, exists, is_dir).
#[tauri::command]
fn file_info(path: String) -> Result<FileInfoResult, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(FileInfoResult {
            exists: false,
            size: 0,
            is_dir: false,
        });
    }
    let meta = fs::metadata(&p).map_err(|e| format!("Failed to stat '{}': {}", path, e))?;
    Ok(FileInfoResult {
        exists: true,
        size: meta.len(),
        is_dir: meta.is_dir(),
    })
}

#[derive(serde::Serialize)]
struct FileInfoResult {
    exists: bool,
    size: u64,
    is_dir: bool,
}

// ── Audio File Reader (WAV Parser) ────────────────────────────────

/// Result of parsing a WAV file in Rust.
/// Each entry in `channels` is one channel's Float32 sample data, normalized to [-1, 1].
/// Frontend uses AudioContext.createBuffer(numChannels, numSamples, sampleRate)
/// then copyToChannel(channels[i], i) for each channel.
#[derive(serde::Serialize)]
struct AudioFileData {
    sample_rate: u32,
    num_channels: u16,
    num_samples: usize,
    channels: Vec<Vec<f32>>,
}

/// Read and parse a WAV file, returning PCM data as per-channel Float32 vectors.
/// This runs in Rust to avoid OOM from browser's decodeAudioData on 300MB+ files.
/// Supports: PCM 16-bit, 24-bit, 32-bit, IEEE Float 32-bit, and WAVE_FORMAT_EXTENSIBLE.
#[tauri::command]
#[allow(clippy::needless_range_loop)]
async fn read_audio_file(path: String) -> Result<AudioFileData, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))?;
    parse_wav_data(&data)
}

/// Parse WAV bytes into AudioFileData. Extracted for testability.
#[allow(clippy::needless_range_loop)]
fn parse_wav_data(data: &[u8]) -> Result<AudioFileData, String> {

    if data.len() < 44 {
        return Err("File too small to be a valid WAV".into());
    }

    // Validate RIFF/WAVE header
    if &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("Not a valid WAV file (missing RIFF/WAVE header)".into());
    }

    // KSDATAFORMAT_SUBTYPE GUIDs for WAVE_FORMAT_EXTENSIBLE
    const SUBFORMAT_PCM: [u8; 16] = [
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
        0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
    ];
    const SUBFORMAT_IEEE_FLOAT: [u8; 16] = [
        0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
        0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
    ];

    // Walk RIFF chunks to find 'fmt ' and 'data'
    let mut format_code: u16 = 0;
    let mut num_channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut data_offset: usize = 0;
    let mut data_size: usize = 0;

    let mut offset: usize = 12;
    while offset + 8 <= data.len() {
        let chunk_id = &data[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            data[offset + 4],
            data[offset + 5],
            data[offset + 6],
            data[offset + 7],
        ]) as usize;

        if chunk_id == b"fmt " {
            if offset + 8 + 16 > data.len() {
                return Err("Truncated fmt chunk".into());
            }
            format_code = u16::from_le_bytes([data[offset + 8], data[offset + 9]]);
            num_channels = u16::from_le_bytes([data[offset + 10], data[offset + 11]]);
            sample_rate = u32::from_le_bytes([
                data[offset + 12],
                data[offset + 13],
                data[offset + 14],
                data[offset + 15],
            ]);
            bits_per_sample = u16::from_le_bytes([data[offset + 22], data[offset + 23]]);

            // WAVE_FORMAT_EXTENSIBLE (0xFFFE): extract actual format from SubFormat GUID
            if format_code == 0xFFFE {
                let fmt_start = offset + 8;
                // Need at least 40 bytes: 18 base + 2 cbSize + 2 validBits + 4 channelMask + 16 subFormat
                if fmt_start + 40 > data.len() {
                    return Err("Truncated WAVEFORMATEXTENSIBLE chunk".into());
                }
                // Valid bits per sample at offset 18
                let valid_bits = u16::from_le_bytes([data[fmt_start + 18], data[fmt_start + 19]]);
                if valid_bits > 0 {
                    bits_per_sample = valid_bits;
                }
                // SubFormat GUID at offset 24
                let sub_format = &data[fmt_start + 24..fmt_start + 40];
                if sub_format == SUBFORMAT_PCM {
                    format_code = 1; // PCM
                } else if sub_format == SUBFORMAT_IEEE_FLOAT {
                    format_code = 3; // IEEE Float
                } else {
                    return Err(format!(
                        "Unsupported WAVEFORMATEXTENSIBLE SubFormat: {:02x?}",
                        sub_format
                    ));
                }
            }
        } else if chunk_id == b"data" {
            data_offset = offset + 8;
            data_size = chunk_size;
        }

        // Chunks are word-aligned
        offset += 8 + chunk_size + (chunk_size % 2);

        if format_code > 0 && data_offset > 0 {
            break;
        }
    }

    if format_code == 0 {
        return Err("WAV file missing 'fmt ' chunk".into());
    }
    if data_offset == 0 {
        return Err("WAV file missing 'data' chunk".into());
    }

    // Validate supported formats
    match (format_code, bits_per_sample) {
        (1, 16) | (1, 24) | (1, 32) | (3, 32) => {}
        _ => {
            return Err(format!(
                "Unsupported WAV format: code={}, bits={}",
                format_code, bits_per_sample
            ))
        }
    }

    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let frame_size = bytes_per_sample * num_channels as usize;
    if frame_size == 0 {
        return Err("Invalid frame size (0)".into());
    }

    // Clamp to actual file length
    let actual_data_end = (data_offset + data_size).min(data.len());
    let num_samples = (actual_data_end - data_offset) / frame_size;

    // Allocate per-channel vectors
    let mut channels: Vec<Vec<f32>> = (0..num_channels)
        .map(|_| vec![0.0f32; num_samples])
        .collect();

    let pcm_data = &data[data_offset..actual_data_end];

    // Convert interleaved PCM to per-channel Float32
    match (format_code, bits_per_sample) {
        (1, 16) => {
            for i in 0..num_samples {
                let frame_start = i * frame_size;
                for ch in 0..num_channels as usize {
                    let off = frame_start + ch * 2;
                    let raw = i16::from_le_bytes([pcm_data[off], pcm_data[off + 1]]);
                    channels[ch][i] = raw as f32 / 32768.0;
                }
            }
        }
        (1, 24) => {
            for i in 0..num_samples {
                let frame_start = i * frame_size;
                for ch in 0..num_channels as usize {
                    let off = frame_start + ch * 3;
                    let b0 = pcm_data[off] as i32;
                    let b1 = pcm_data[off + 1] as i32;
                    let b2 = pcm_data[off + 2] as i32;
                    let mut val = b0 | (b1 << 8) | (b2 << 16);
                    if b2 & 0x80 != 0 {
                        val -= 0x1000000;
                    }
                    channels[ch][i] = val as f32 / 8388608.0;
                }
            }
        }
        (1, 32) => {
            for i in 0..num_samples {
                let frame_start = i * frame_size;
                for ch in 0..num_channels as usize {
                    let off = frame_start + ch * 4;
                    let raw = i32::from_le_bytes([
                        pcm_data[off],
                        pcm_data[off + 1],
                        pcm_data[off + 2],
                        pcm_data[off + 3],
                    ]);
                    channels[ch][i] = raw as f32 / 2147483648.0;
                }
            }
        }
        (3, 32) => {
            for i in 0..num_samples {
                let frame_start = i * frame_size;
                for ch in 0..num_channels as usize {
                    let off = frame_start + ch * 4;
                    channels[ch][i] = f32::from_le_bytes([
                        pcm_data[off],
                        pcm_data[off + 1],
                        pcm_data[off + 2],
                        pcm_data[off + 3],
                    ]);
                }
            }
        }
        _ => unreachable!(),
    }

    // Sanitize: replace NaN/Infinity with 0.0 to prevent serde_json serialization failures
    for ch in channels.iter_mut() {
        for sample in ch.iter_mut() {
            if !sample.is_finite() {
                *sample = 0.0;
            }
        }
    }

    Ok(AudioFileData {
        sample_rate,
        num_channels,
        num_samples,
        channels,
    })
}

/// Read and parse a WAV file, returning binary PCM data via IPC Response.
/// Eliminates JSON serialization overhead for million-float arrays.
///
/// Binary layout:
/// - [0..4]   sample_rate: u32 LE
/// - [4..6]   num_channels: u16 LE
/// - [6..8]   padding: u16 (0)
/// - [8..16]  num_samples: u64 LE
/// - [16..]   raw f32 PCM, channel-sequential: [ch0_all, ch1_all, ...]
#[tauri::command]
async fn read_audio_file_binary(path: String) -> Result<Response, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))?;
    let parsed = parse_wav_data(&data)?;

    let total_floats = parsed.num_channels as usize * parsed.num_samples;
    let mut buf = Vec::with_capacity(16 + total_floats * 4);

    buf.extend_from_slice(&parsed.sample_rate.to_le_bytes());
    buf.extend_from_slice(&parsed.num_channels.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes()); // padding for alignment
    buf.extend_from_slice(&(parsed.num_samples as u64).to_le_bytes());

    for ch_data in &parsed.channels {
        // SAFETY: f32 has a well-defined 4-byte LE layout on all supported platforms.
        let bytes: &[u8] = unsafe {
            std::slice::from_raw_parts(ch_data.as_ptr() as *const u8, ch_data.len() * 4)
        };
        buf.extend_from_slice(bytes);
    }

    Ok(Response::new(buf))
}

// ── Audio File Metadata Scanner ───────────────────────────────────

/// Metadata extracted from a WAV file's header chunks (no PCM data loaded).
#[derive(serde::Serialize, Clone, Default)]
struct AudioFileMeta {
    path: String,
    name: String,
    extension: String,
    size: u64,
    // WAV-specific (None for non-WAV)
    channels: Option<u16>,
    sample_rate: Option<u32>,
    bits_per_sample: Option<u16>,
    duration_secs: Option<f64>,
    // BWF BEXT metadata
    bext_description: Option<String>,
    bext_originator: Option<String>,
    bext_originator_ref: Option<String>,
    bext_date: Option<String>,
    bext_time: Option<String>,
    bext_coding_history: Option<String>,
    // iXML raw content
    ixml: Option<String>,
}

/// Read a fixed-length ASCII/Latin-1 field from BEXT, trimming trailing nulls and whitespace.
fn read_bext_field(data: &[u8], offset: usize, len: usize) -> Option<String> {
    if offset + len > data.len() {
        return None;
    }
    let raw = &data[offset..offset + len];
    let s = String::from_utf8_lossy(raw);
    let trimmed = s.trim_end_matches('\0').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Extract metadata from WAV file bytes (header chunks only, no PCM decoding).
/// Reads fmt, data (size only), bext, and iXML chunks.
fn extract_wav_metadata(data: &[u8]) -> Option<AudioFileMeta> {
    if data.len() < 44 {
        return None;
    }
    if &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return None;
    }

    let mut meta = AudioFileMeta::default();
    let mut channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut data_chunk_size: u64 = 0;

    let mut offset: usize = 12;
    while offset + 8 <= data.len() {
        let chunk_id = &data[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            data[offset + 4],
            data[offset + 5],
            data[offset + 6],
            data[offset + 7],
        ]) as usize;

        let chunk_data_start = offset + 8;

        match chunk_id {
            b"fmt " => {
                if chunk_data_start + 16 > data.len() {
                    break;
                }
                let fmt_code = u16::from_le_bytes([data[chunk_data_start], data[chunk_data_start + 1]]);
                channels = u16::from_le_bytes([data[chunk_data_start + 2], data[chunk_data_start + 3]]);
                sample_rate = u32::from_le_bytes([
                    data[chunk_data_start + 4],
                    data[chunk_data_start + 5],
                    data[chunk_data_start + 6],
                    data[chunk_data_start + 7],
                ]);
                bits_per_sample = u16::from_le_bytes([data[chunk_data_start + 14], data[chunk_data_start + 15]]);

                // WAVE_FORMAT_EXTENSIBLE: extract valid bits per sample
                if fmt_code == 0xFFFE && chunk_data_start + 40 <= data.len() {
                    let valid_bits = u16::from_le_bytes([data[chunk_data_start + 18], data[chunk_data_start + 19]]);
                    if valid_bits > 0 {
                        bits_per_sample = valid_bits;
                    }
                }
            }
            b"data" => {
                data_chunk_size = chunk_size as u64;
            }
            b"bext" => {
                // BWF BEXT chunk layout (EBU Tech 3285):
                //   0..256   description (ASCII)
                //   256..288 originator (ASCII)
                //   288..320 originatorReference (ASCII)
                //   320..330 originationDate (ASCII, yyyy-mm-dd)
                //   330..338 originationTime (ASCII, hh:mm:ss)
                //   338..346 timeReference (u64 LE)
                //   346..348 version (u16 LE)
                //   ...
                //   602+     codingHistory (free text, rest of chunk)
                meta.bext_description = read_bext_field(data, chunk_data_start, 256);
                meta.bext_originator = read_bext_field(data, chunk_data_start + 256, 32);
                meta.bext_originator_ref = read_bext_field(data, chunk_data_start + 288, 32);
                meta.bext_date = read_bext_field(data, chunk_data_start + 320, 10);
                meta.bext_time = read_bext_field(data, chunk_data_start + 330, 8);

                // Coding history starts at offset 602 within the bext chunk data
                let coding_start = chunk_data_start + 602;
                let coding_end = chunk_data_start + chunk_size;
                if coding_start < coding_end && coding_end <= data.len() {
                    let raw = &data[coding_start..coding_end];
                    let s = String::from_utf8_lossy(raw);
                    let trimmed = s.trim_end_matches('\0').trim();
                    if !trimmed.is_empty() {
                        meta.bext_coding_history = Some(trimmed.to_string());
                    }
                }
            }
            b"iXML" => {
                let end = (chunk_data_start + chunk_size).min(data.len());
                if chunk_data_start < end {
                    let raw = &data[chunk_data_start..end];
                    let s = String::from_utf8_lossy(raw);
                    let trimmed = s.trim_end_matches('\0').trim();
                    if !trimmed.is_empty() {
                        meta.ixml = Some(trimmed.to_string());
                    }
                }
            }
            _ => {}
        }

        // Chunks are word-aligned (pad to even)
        offset += 8 + chunk_size + (chunk_size % 2);
    }

    if channels > 0 && sample_rate > 0 {
        meta.channels = Some(channels);
        meta.sample_rate = Some(sample_rate);
        meta.bits_per_sample = Some(bits_per_sample);

        let bytes_per_sample = (bits_per_sample as u64) / 8;
        let frame_size = bytes_per_sample * channels as u64;
        if frame_size > 0 && sample_rate > 0 {
            let num_frames = data_chunk_size / frame_size;
            meta.duration_secs = Some(num_frames as f64 / sample_rate as f64);
        }
    }

    // If we only have format_code without channels/rate, treat as unparseable
    if meta.channels.is_none()
        && meta.bext_description.is_none()
        && meta.ixml.is_none()
    {
        return None;
    }

    Some(meta)
}

/// Read metadata for a single audio file.
#[tauri::command]
fn read_file_metadata(path: String) -> Result<AudioFileMeta, String> {
    use std::io::Read;

    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("'{}' is not a file", path));
    }

    let file_meta = fs::metadata(&p)
        .map_err(|e| format!("Failed to stat '{}': {}", path, e))?;

    let name = p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut result = AudioFileMeta {
        path: path.clone(),
        name,
        extension: ext.clone(),
        size: file_meta.len(),
        ..Default::default()
    };

    // Only parse WAV metadata
    if ext == "wav" || ext == "wave" {
        // Read first 128KB for metadata (all header chunks come before data)
        let mut buf = vec![0u8; 131_072.min(file_meta.len() as usize)];
        let mut file = fs::File::open(&p)
            .map_err(|e| format!("Failed to open '{}': {}", path, e))?;
        let bytes_read = file.read(&mut buf)
            .map_err(|e| format!("Failed to read '{}': {}", path, e))?;
        buf.truncate(bytes_read);

        if let Some(wav_meta) = extract_wav_metadata(&buf) {
            result.channels = wav_meta.channels;
            result.sample_rate = wav_meta.sample_rate;
            result.bits_per_sample = wav_meta.bits_per_sample;
            result.duration_secs = wav_meta.duration_secs;
            result.bext_description = wav_meta.bext_description;
            result.bext_originator = wav_meta.bext_originator;
            result.bext_originator_ref = wav_meta.bext_originator_ref;
            result.bext_date = wav_meta.bext_date;
            result.bext_time = wav_meta.bext_time;
            result.bext_coding_history = wav_meta.bext_coding_history;
            result.ixml = wav_meta.ixml;
        }
    }

    Ok(result)
}

/// Scan a directory for audio files with metadata. Returns entries sorted by name.
#[tauri::command]
async fn scan_audio_folder(path: String) -> Result<Vec<AudioFileMeta>, String> {
    use std::io::Read;

    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("'{}' is not a directory", path));
    }

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", path, e))?;

    let mut files: Vec<AudioFileMeta> = Vec::new();

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let ext = entry_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }

        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        let mut meta = AudioFileMeta {
            path: entry_path.to_string_lossy().to_string(),
            name,
            extension: ext.clone(),
            size,
            ..Default::default()
        };

        // Extract WAV metadata from header
        if ext == "wav" || ext == "wave" {
            if let Ok(mut file) = fs::File::open(&entry_path) {
                let read_size = 131_072_usize.min(size as usize);
                let mut buf = vec![0u8; read_size];
                if let Ok(n) = file.read(&mut buf) {
                    buf.truncate(n);
                    if let Some(wav_meta) = extract_wav_metadata(&buf) {
                        meta.channels = wav_meta.channels;
                        meta.sample_rate = wav_meta.sample_rate;
                        meta.bits_per_sample = wav_meta.bits_per_sample;
                        meta.duration_secs = wav_meta.duration_secs;
                        meta.bext_description = wav_meta.bext_description;
                        meta.bext_originator = wav_meta.bext_originator;
                        meta.bext_originator_ref = wav_meta.bext_originator_ref;
                        meta.bext_date = wav_meta.bext_date;
                        meta.bext_time = wav_meta.bext_time;
                        meta.bext_coding_history = wav_meta.bext_coding_history;
                        meta.ixml = wav_meta.ixml;
                    }
                }
            }
        }

        files.push(meta);
    }

    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

// ── Folder Scanning ───────────────────────────────────────────────

#[derive(serde::Serialize)]
struct AudioFileInfo {
    path: String,
    name: String,
    size: u64,
    extension: String,
}

const AUDIO_EXTENSIONS: &[&str] = &["wav", "aif", "aiff", "flac", "mp3", "ogg", "m4a"];

/// Scan a directory for audio files. Returns entries sorted by name.
#[tauri::command]
async fn scan_folder(path: String) -> Result<Vec<AudioFileInfo>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("'{}' is not a directory", path));
    }

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", path, e))?;

    let mut files: Vec<AudioFileInfo> = Vec::new();

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let ext = entry_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }

        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        files.push(AudioFileInfo {
            path: entry_path.to_string_lossy().to_string(),
            name,
            size,
            extension: ext,
        });
    }

    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

/// Open a folder picker dialog. Returns selected path or empty string.
#[tauri::command]
async fn open_folder_dialog(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let result = app
        .dialog()
        .file()
        .set_title("Select Audio Folder")
        .blocking_pick_folder();

    match result {
        Some(path) => Ok(path.as_path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()),
        None => Ok(String::new()),
    }
}

// ── Menu Setup ────────────────────────────────────────────────────

fn setup_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Helper: create a menu item with an accelerator.
    // The `id` is used to match events; we emit `menu:{id}` to the frontend.
    macro_rules! item {
        ($app:expr, $id:expr, $label:expr, $accel:expr) => {
            MenuItemBuilder::with_id($id, $label)
                .accelerator($accel)
                .build($app)?
        };
        ($app:expr, $id:expr, $label:expr) => {
            MenuItemBuilder::with_id($id, $label).build($app)?
        };
    }

    let handle = app.handle();

    // ── App menu (macOS only) ─────────────────────────────────
    let app_menu = SubmenuBuilder::new(handle, "FieldCorder")
        .about(None)
        .separator()
        .item(&item!(handle, "preferences", "Preferences...", "CmdOrCtrl+,"))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // ── File menu ─────────────────────────────────────────────
    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(&item!(handle, "new-project", "New Project", "CmdOrCtrl+N"))
        .separator()
        .item(&item!(handle, "import", "Import Audio...", "CmdOrCtrl+O"))
        .item(&item!(handle, "import-folder", "Import Folder...", "CmdOrCtrl+Shift+O"))
        .separator()
        .item(&item!(handle, "export", "Export...", "CmdOrCtrl+E"))
        .item(&item!(handle, "export-all-channels", "Export All Channels...", "CmdOrCtrl+Shift+E"))
        .separator()
        .item(&item!(handle, "save-project", "Save Project", "CmdOrCtrl+S"))
        .item(&item!(handle, "load-project", "Load Project...", "CmdOrCtrl+Shift+S"))
        .separator()
        .close_window()
        .build()?;

    // ── Edit menu ─────────────────────────────────────────────
    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .item(&item!(handle, "undo", "Undo", "CmdOrCtrl+Z"))
        .item(&item!(handle, "redo", "Redo", "CmdOrCtrl+Shift+Z"))
        .separator()
        .item(&item!(handle, "select-all", "Select All", "CmdOrCtrl+A"))
        .item(&item!(handle, "delete", "Delete Selection", "Backspace"))
        .separator()
        .item(&item!(handle, "trim", "Trim to Selection", "CmdOrCtrl+T"))
        .item(&item!(handle, "normalize", "Normalize...", ""))
        .item(&item!(handle, "new-track", "New Empty Track", "CmdOrCtrl+Shift+N"))
        .item(&item!(handle, "fade-in", "Fade In", "CmdOrCtrl+F"))
        .item(&item!(handle, "fade-out", "Fade Out", "CmdOrCtrl+Shift+F"))
        .item(&item!(handle, "gain", "Apply Gain...", "CmdOrCtrl+G"))
        .item(&item!(handle, "reverse", "Reverse", "CmdOrCtrl+R"))
        .build()?;

    // ── Transport menu ────────────────────────────────────────
    let transport_menu = SubmenuBuilder::new(handle, "Transport")
        .item(&item!(handle, "play-pause", "Play / Pause", "Space"))
        .item(&item!(handle, "stop", "Stop", "Escape"))
        .separator()
        .item(&item!(handle, "toggle-loop", "Toggle Loop", "L"))
        .build()?;

    // ── View menu ─────────────────────────────────────────────
    let channel_stereo = item!(handle, "channel-layout-2", "Stereo (2ch)");
    let channel_quad = item!(handle, "channel-layout-4", "Quad (4ch)");
    let channel_surround = item!(handle, "channel-layout-6", "5.1 Surround (6ch)");

    let channel_submenu = SubmenuBuilder::new(handle, "Channel Layout")
        .item(&channel_stereo)
        .item(&channel_quad)
        .item(&channel_surround)
        .build()?;

    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(&item!(handle, "zoom-in", "Zoom In", "CmdOrCtrl+="))
        .item(&item!(handle, "zoom-out", "Zoom Out", "CmdOrCtrl+-"))
        .item(&item!(handle, "zoom-fit", "Zoom to Fit", "CmdOrCtrl+0"))
        .separator()
        .item(&item!(handle, "toggle-mixer", "Toggle Mixer", "CmdOrCtrl+M"))
        .item(&item!(handle, "toggle-plugin-browser", "Toggle Plugin Browser", "CmdOrCtrl+B"))
        .separator()
        .item(&channel_submenu)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .build()?;

    // ── Window menu ───────────────────────────────────────────
    let window_menu = SubmenuBuilder::new(handle, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    // ── Help menu ─────────────────────────────────────────────
    let help_menu = SubmenuBuilder::new(handle, "Help")
        .item(&item!(handle, "shortcuts", "Keyboard Shortcuts"))
        .build()?;

    // ── Build and set the full menu ───────────────────────────
    let menu = MenuBuilder::new(handle)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&transport_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;

    // ── Handle menu events → emit to frontend ─────────────────
    let handle = app.handle().clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().0.as_str();

        // Channel layout items carry a numeric payload
        if let Some(suffix) = id.strip_prefix("channel-layout-") {
            if let Ok(num) = suffix.parse::<u32>() {
                let _ = handle.emit("menu:channel-layout", num);
                return;
            }
        }

        // All other items: emit "menu:{id}" with no payload
        let event_name = format!("menu:{}", id);
        let _ = handle.emit(&event_name, ());
    });

    Ok(())
}

// ── DeepFilter Noise Reduction ────────────────────────────────────

#[derive(serde::Deserialize)]
struct DenoiseParams {
    denoise: f32,
    dereverb: f32,
    dry: f32,
    sample_rate: u32,
    num_samples: u64,
}

/// Map denoise slider value (0.0–1.0) to attenuation limit in dB.
fn denoise_to_atten_lim_db(denoise: f32) -> f32 {
    denoise * 100.0
}

/// Map dereverb slider value (0.0–1.0) to post-filter beta.
fn dereverb_to_pf_beta(dereverb: f32) -> f32 {
    dereverb * 0.05
}

/// Apply dry/wet mix: `output[i] = dry * original[i] + (1 - dry) * processed[i]`.
fn apply_dry_wet_mix(original: &[f32], processed: &[f32], dry: f32) -> Vec<f32> {
    let wet = 1.0 - dry;
    original
        .iter()
        .zip(processed.iter())
        .map(|(&o, &p)| dry * o + wet * p)
        .collect()
}

/// DeepFilter-based noise reduction via binary IPC.
///
/// Request format:
/// - Header `x-denoise-params`: JSON-encoded [`DenoiseParams`]
/// - Body: raw f32 LE PCM bytes (mono)
///
/// Response binary layout (same as `read_audio_file_binary`):
/// - [0..4]   sample_rate: u32 LE
/// - [4..6]   num_channels: u16 LE (always 1)
/// - [6..8]   padding: u16
/// - [8..16]  num_samples: u64 LE
/// - [16..]   f32 LE PCM data
#[tauri::command]
async fn denoise_deepfilter(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<Response, String> {
    // 1. Parse params from header
    let params_json = request
        .headers()
        .get("x-denoise-params")
        .ok_or("Missing x-denoise-params header")?
        .to_str()
        .map_err(|e| format!("Invalid params header: {}", e))?;
    let params: DenoiseParams = serde_json::from_str(params_json)
        .map_err(|e| format!("Failed to parse denoise params: {}", e))?;

    // 2. Extract raw f32 PCM from body
    let input_samples: Vec<f32> = {
        let raw_bytes = match request.body() {
            tauri::ipc::InvokeBody::Raw(data) => data.as_slice(),
            tauri::ipc::InvokeBody::Json(_) => {
                return Err("Expected raw binary body, got JSON".into());
            }
        };
        if raw_bytes.len() % 4 != 0 {
            return Err("Audio data length is not aligned to 4 bytes (f32)".into());
        }
        raw_bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect()
    };

    if input_samples.len() != params.num_samples as usize {
        return Err(format!(
            "Sample count mismatch: header says {} but body has {}",
            params.num_samples,
            input_samples.len()
        ));
    }

    // Save original for dry/wet mix
    let original = input_samples.clone();

    // 3. Resample to 48kHz if needed (DeepFilter requires 48kHz)
    let df_sr: usize = 48000;
    let (samples_48k, was_resampled) = if params.sample_rate as usize != df_sr {
        let arr =
            ndarray::Array2::from_shape_vec((1, input_samples.len()), input_samples)
                .map_err(|e| format!("Array creation failed: {}", e))?;
        let resampled =
            df::transforms::resample(arr.view(), params.sample_rate as usize, df_sr, None)
                .map_err(|e| format!("Resample to 48kHz failed: {}", e))?;
        (resampled.row(0).to_vec(), true)
    } else {
        (input_samples, false)
    };

    // 4. Create DfTract processor
    let atten_lim = denoise_to_atten_lim_db(params.denoise);
    let pf_beta = dereverb_to_pf_beta(params.dereverb);

    let df_params = df::tract::DfParams::default();
    let r_params = df::tract::RuntimeParams::default_with_ch(1)
        .with_atten_lim(atten_lim)
        .with_post_filter(pf_beta);
    let mut model = df::tract::DfTract::new(df_params, &r_params)
        .map_err(|e| format!("DfTract init failed: {}", e))?;

    // 5. Process in hop_size chunks
    let hop_size = model.hop_size;
    let num_48k = samples_48k.len();
    let total_hops = num_48k.div_ceil(hop_size);
    let mut output_48k = vec![0.0f32; num_48k];

    for (i, start) in (0..num_48k).step_by(hop_size).enumerate() {
        let end = (start + hop_size).min(num_48k);
        let actual_len = end - start;

        // Pad last chunk to hop_size if needed
        let mut chunk = vec![0.0f32; hop_size];
        chunk[..actual_len].copy_from_slice(&samples_48k[start..end]);

        let noisy = ndarray::Array2::from_shape_vec((1, hop_size), chunk)
            .map_err(|e| format!("Noisy array creation failed: {}", e))?;
        let mut enh = ndarray::Array2::<f32>::zeros((1, hop_size));

        model
            .process(noisy.view(), enh.view_mut())
            .map_err(|e| format!("DeepFilter process error at hop {}: {}", i, e))?;

        for j in 0..actual_len {
            output_48k[start + j] = enh[[0, j]];
        }

        // 6. Emit progress events every ~50 hops
        if i % 50 == 0 || i == total_hops - 1 {
            let percent = ((i + 1) as f64 / total_hops as f64 * 100.0) as u32;
            let _ = app.emit("denoise:progress", percent);
        }
    }

    // 7. Resample back to original sample rate if needed
    let processed = if was_resampled {
        let arr = ndarray::Array2::from_shape_vec((1, output_48k.len()), output_48k)
            .map_err(|e| format!("Array creation failed: {}", e))?;
        let resampled =
            df::transforms::resample(arr.view(), df_sr, params.sample_rate as usize, None)
                .map_err(|e| format!("Resample back failed: {}", e))?;
        let mut v = resampled.row(0).to_vec();
        v.resize(original.len(), 0.0);
        v
    } else {
        output_48k
    };

    // 8. Apply dry/wet mix
    let final_output = apply_dry_wet_mix(&original, &processed, params.dry);

    // 9. Build binary response
    let num_out_samples = final_output.len();
    let mut buf = Vec::with_capacity(16 + num_out_samples * 4);
    buf.extend_from_slice(&params.sample_rate.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes()); // mono
    buf.extend_from_slice(&0u16.to_le_bytes()); // padding
    buf.extend_from_slice(&(num_out_samples as u64).to_le_bytes());

    // SAFETY: f32 has well-defined 4-byte LE layout on all supported platforms.
    let pcm_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            final_output.as_ptr() as *const u8,
            final_output.len() * 4,
        )
    };
    buf.extend_from_slice(pcm_bytes);

    Ok(Response::new(buf))
}

// ── App Entry ─────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            save_file_dialog,
            read_file_bytes,
            read_file_text,
            write_file,
            write_binary_file,
            file_info,
            read_audio_file,
            read_audio_file_binary,
            read_file_metadata,
            scan_audio_folder,
            scan_folder,
            open_folder_dialog,
            denoise_deepfilter,
        ])
        .register_asynchronous_uri_scheme_protocol("localfile", |_ctx, request, responder| {
            std::thread::spawn(move || {
                let uri = request.uri().to_string();
                let path = uri
                    .strip_prefix("localfile://localhost")
                    .or_else(|| uri.strip_prefix("localfile:///"))
                    .unwrap_or(&uri);
                let decoded = urlencoding::decode(path).unwrap_or_else(|_| path.into());
                let file_path = PathBuf::from(decoded.as_ref());

                if !file_path.exists() {
                    let resp = tauri::http::Response::builder()
                        .status(404)
                        .body(b"File not found".to_vec())
                        .unwrap();
                    responder.respond(resp);
                    return;
                }

                match fs::read(&file_path) {
                    Ok(data) => {
                        let mime = match file_path
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("")
                        {
                            "wav" => "audio/wav",
                            "mp3" => "audio/mpeg",
                            "flac" => "audio/flac",
                            "ogg" => "audio/ogg",
                            "aiff" | "aif" => "audio/aiff",
                            "json" => "application/json",
                            "txt" => "text/plain",
                            _ => "application/octet-stream",
                        };
                        let resp = tauri::http::Response::builder()
                            .status(200)
                            .header("Content-Type", mime)
                            .header("Content-Length", data.len().to_string())
                            .header("Access-Control-Allow-Origin", "*")
                            .body(data)
                            .unwrap();
                        responder.respond(resp);
                    }
                    Err(e) => {
                        let msg = format!("Failed to read file: {}", e);
                        let resp = tauri::http::Response::builder()
                            .status(500)
                            .body(msg.into_bytes())
                            .unwrap();
                        responder.respond(resp);
                    }
                }
            });
        })
        .setup(|app| {
            // Set up native menu
            if let Err(e) = setup_menu(app) {
                eprintln!("Failed to setup menu: {}", e);
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal WAV file in memory for testing.
    fn build_wav(format_code: u16, bits_per_sample: u16, channels: u16, sample_rate: u32, data: &[u8]) -> Vec<u8> {
        let fmt_chunk_size: u32 = 16;
        let data_chunk_size = data.len() as u32;
        let riff_size = 4 + (8 + fmt_chunk_size) + (8 + data_chunk_size);
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * block_align as u32;

        let mut buf = Vec::new();
        // RIFF header
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&riff_size.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        // fmt chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&fmt_chunk_size.to_le_bytes());
        buf.extend_from_slice(&format_code.to_le_bytes());
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&block_align.to_le_bytes());
        buf.extend_from_slice(&bits_per_sample.to_le_bytes());
        // data chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_chunk_size.to_le_bytes());
        buf.extend_from_slice(data);
        buf
    }

    #[test]
    fn test_parse_32bit_float_wav() {
        let sample1: f32 = 0.5;
        let sample2: f32 = -0.25;
        let mut data = Vec::new();
        data.extend_from_slice(&sample1.to_le_bytes());
        data.extend_from_slice(&sample2.to_le_bytes());

        let wav = build_wav(3, 32, 1, 48000, &data);
        let result = parse_wav_data(&wav).unwrap();
        assert_eq!(result.sample_rate, 48000);
        assert_eq!(result.num_channels, 1);
        assert_eq!(result.num_samples, 2);
        assert!((result.channels[0][0] - 0.5).abs() < 1e-6);
        assert!((result.channels[0][1] - (-0.25)).abs() < 1e-6);
    }

    #[test]
    fn test_parse_32bit_float_stereo() {
        let l: f32 = 0.75;
        let r: f32 = -0.5;
        let mut data = Vec::new();
        data.extend_from_slice(&l.to_le_bytes());
        data.extend_from_slice(&r.to_le_bytes());

        let wav = build_wav(3, 32, 2, 44100, &data);
        let result = parse_wav_data(&wav).unwrap();
        assert_eq!(result.num_channels, 2);
        assert_eq!(result.num_samples, 1);
        assert!((result.channels[0][0] - 0.75).abs() < 1e-6);
        assert!((result.channels[1][0] - (-0.5)).abs() < 1e-6);
    }

    #[test]
    fn test_nan_infinity_sanitized() {
        let mut data = Vec::new();
        data.extend_from_slice(&f32::NAN.to_le_bytes());
        data.extend_from_slice(&f32::INFINITY.to_le_bytes());
        data.extend_from_slice(&f32::NEG_INFINITY.to_le_bytes());
        data.extend_from_slice(&0.3f32.to_le_bytes());

        let wav = build_wav(3, 32, 1, 48000, &data);
        let result = parse_wav_data(&wav).unwrap();
        assert_eq!(result.channels[0][0], 0.0); // NaN → 0.0
        assert_eq!(result.channels[0][1], 0.0); // Inf → 0.0
        assert_eq!(result.channels[0][2], 0.0); // -Inf → 0.0
        assert!((result.channels[0][3] - 0.3).abs() < 1e-6);
    }

    /// Test binary serialization layout matches the documented spec.
    #[test]
    fn test_binary_serialization_layout() {
        let sample_l: f32 = 0.75;
        let sample_r: f32 = -0.5;
        let mut data = Vec::new();
        data.extend_from_slice(&sample_l.to_le_bytes());
        data.extend_from_slice(&sample_r.to_le_bytes());

        let wav = build_wav(3, 32, 2, 44100, &data);
        let parsed = parse_wav_data(&wav).unwrap();

        // Serialize to binary using the same logic as read_audio_file_binary
        let total_floats = parsed.num_channels as usize * parsed.num_samples;
        let mut buf = Vec::with_capacity(16 + total_floats * 4);
        buf.extend_from_slice(&parsed.sample_rate.to_le_bytes());
        buf.extend_from_slice(&parsed.num_channels.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&(parsed.num_samples as u64).to_le_bytes());
        for ch_data in &parsed.channels {
            let bytes: &[u8] = unsafe {
                std::slice::from_raw_parts(ch_data.as_ptr() as *const u8, ch_data.len() * 4)
            };
            buf.extend_from_slice(bytes);
        }

        // Verify header
        assert_eq!(buf.len(), 16 + 2 * 4); // 16 header + 2 floats
        assert_eq!(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]), 44100);
        assert_eq!(u16::from_le_bytes([buf[4], buf[5]]), 2);
        assert_eq!(u16::from_le_bytes([buf[6], buf[7]]), 0); // padding
        assert_eq!(u64::from_le_bytes([buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]]), 1);

        // Verify PCM data: ch0 then ch1
        let ch0_val = f32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]);
        let ch1_val = f32::from_le_bytes([buf[20], buf[21], buf[22], buf[23]]);
        assert!((ch0_val - 0.75).abs() < 1e-6);
        assert!((ch1_val - (-0.5)).abs() < 1e-6);
    }

    #[test]
    fn test_parse_16bit_pcm() {
        let s1: i16 = 16384; // ~0.5
        let s2: i16 = -16384; // ~-0.5
        let mut data = Vec::new();
        data.extend_from_slice(&s1.to_le_bytes());
        data.extend_from_slice(&s2.to_le_bytes());

        let wav = build_wav(1, 16, 1, 44100, &data);
        let result = parse_wav_data(&wav).unwrap();
        assert_eq!(result.sample_rate, 44100);
        assert_eq!(result.num_channels, 1);
        assert_eq!(result.num_samples, 2);
        assert!((result.channels[0][0] - 0.5).abs() < 0.001);
        assert!((result.channels[0][1] - (-0.5)).abs() < 0.001);
    }

    // ── Metadata scanner tests ───────────────────────────────────

    /// Build a WAV with extra chunks (bext, iXML) for metadata testing.
    fn build_wav_with_metadata(
        channels: u16,
        sample_rate: u32,
        bits_per_sample: u16,
        pcm_data: &[u8],
        bext: Option<&[u8]>,
        ixml: Option<&[u8]>,
    ) -> Vec<u8> {
        let fmt_chunk_size: u32 = 16;
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * block_align as u32;

        let mut buf = Vec::new();
        // Placeholder RIFF header (size filled later)
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(b"WAVE");

        // fmt chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&fmt_chunk_size.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&block_align.to_le_bytes());
        buf.extend_from_slice(&bits_per_sample.to_le_bytes());

        // bext chunk
        if let Some(bext_data) = bext {
            buf.extend_from_slice(b"bext");
            buf.extend_from_slice(&(bext_data.len() as u32).to_le_bytes());
            buf.extend_from_slice(bext_data);
            if bext_data.len() % 2 != 0 {
                buf.push(0); // word-align
            }
        }

        // iXML chunk
        if let Some(ixml_data) = ixml {
            buf.extend_from_slice(b"iXML");
            buf.extend_from_slice(&(ixml_data.len() as u32).to_le_bytes());
            buf.extend_from_slice(ixml_data);
            if ixml_data.len() % 2 != 0 {
                buf.push(0);
            }
        }

        // data chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&(pcm_data.len() as u32).to_le_bytes());
        buf.extend_from_slice(pcm_data);

        // Fill in RIFF size
        let riff_size = (buf.len() - 8) as u32;
        buf[4..8].copy_from_slice(&riff_size.to_le_bytes());

        buf
    }

    #[test]
    fn test_extract_wav_metadata_basic() {
        // 2ch, 48kHz, 16-bit, 100 frames = 400 bytes of PCM
        let pcm = vec![0u8; 400];
        let wav = build_wav_with_metadata(2, 48000, 16, &pcm, None, None);

        let meta = extract_wav_metadata(&wav).unwrap();
        assert_eq!(meta.channels, Some(2));
        assert_eq!(meta.sample_rate, Some(48000));
        assert_eq!(meta.bits_per_sample, Some(16));
        // 400 bytes / (2ch * 2 bytes) = 100 frames, 100/48000 ≈ 0.00208s
        assert!((meta.duration_secs.unwrap() - 100.0 / 48000.0).abs() < 1e-6);
        assert!(meta.bext_description.is_none());
        assert!(meta.ixml.is_none());
    }

    #[test]
    fn test_extract_wav_metadata_with_bext() {
        // Build a minimal BEXT chunk (need at least 602 bytes for coding_history)
        let mut bext = vec![0u8; 700];
        // description at offset 0..256
        let desc = b"Field recording - city ambience";
        bext[..desc.len()].copy_from_slice(desc);
        // originator at offset 256..288
        let orig = b"FieldCorder";
        bext[256..256 + orig.len()].copy_from_slice(orig);
        // originator_ref at offset 288..320
        let orig_ref = b"FC-20260226-001";
        bext[288..288 + orig_ref.len()].copy_from_slice(orig_ref);
        // date at offset 320..330
        let date = b"2026-02-26";
        bext[320..330].copy_from_slice(date);
        // time at offset 330..338
        let time = b"14:30:00";
        bext[330..338].copy_from_slice(time);
        // coding_history at offset 602+
        let coding = b"A=PCM,F=48000,W=24,M=stereo";
        bext[602..602 + coding.len()].copy_from_slice(coding);

        let pcm = vec![0u8; 48]; // small data chunk
        let wav = build_wav_with_metadata(1, 48000, 16, &pcm, Some(&bext), None);

        let meta = extract_wav_metadata(&wav).unwrap();
        assert_eq!(meta.bext_description.as_deref(), Some("Field recording - city ambience"));
        assert_eq!(meta.bext_originator.as_deref(), Some("FieldCorder"));
        assert_eq!(meta.bext_originator_ref.as_deref(), Some("FC-20260226-001"));
        assert_eq!(meta.bext_date.as_deref(), Some("2026-02-26"));
        assert_eq!(meta.bext_time.as_deref(), Some("14:30:00"));
        assert_eq!(meta.bext_coding_history.as_deref(), Some("A=PCM,F=48000,W=24,M=stereo"));
    }

    #[test]
    fn test_extract_wav_metadata_with_ixml() {
        let ixml_content = b"<?xml version=\"1.0\"?><BWFXML><IXML_VERSION>1.0</IXML_VERSION><PROJECT>TestProject</PROJECT></BWFXML>";
        let pcm = vec![0u8; 48];
        let wav = build_wav_with_metadata(1, 44100, 16, &pcm, None, Some(ixml_content));

        let meta = extract_wav_metadata(&wav).unwrap();
        assert!(meta.ixml.is_some());
        assert!(meta.ixml.as_ref().unwrap().contains("<PROJECT>TestProject</PROJECT>"));
    }

    #[test]
    fn test_extract_wav_metadata_non_wav_returns_none() {
        // Not a RIFF file
        let data = b"NOT_A_WAV_FILE_AT_ALL_JUST_RANDOM_BYTES_HERE_OK";
        assert!(extract_wav_metadata(data).is_none());
    }

    #[test]
    fn test_extract_wav_metadata_duration_calculation() {
        // 1ch, 44100 Hz, 16-bit, 44100 frames = 88200 bytes → exactly 1.0 second
        let pcm = vec![0u8; 88200];
        let wav = build_wav_with_metadata(1, 44100, 16, &pcm, None, None);

        let meta = extract_wav_metadata(&wav).unwrap();
        assert!((meta.duration_secs.unwrap() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_read_bext_field_trims_nulls() {
        let mut data = vec![0u8; 32];
        data[0..5].copy_from_slice(b"Hello");
        // Rest is null bytes
        let result = read_bext_field(&data, 0, 32);
        assert_eq!(result.as_deref(), Some("Hello"));
    }

    #[test]
    fn test_read_bext_field_empty() {
        let data = vec![0u8; 32];
        let result = read_bext_field(&data, 0, 32);
        assert!(result.is_none());
    }

    // ── DeepFilter denoise tests ─────────────────────────────────

    #[test]
    fn test_denoise_params_deserialization() {
        let json = r#"{"denoise":0.5,"dereverb":0.3,"dry":0.2,"sample_rate":48000,"num_samples":1000}"#;
        let params: DenoiseParams = serde_json::from_str(json).unwrap();
        assert!((params.denoise - 0.5).abs() < f32::EPSILON);
        assert!((params.dereverb - 0.3).abs() < f32::EPSILON);
        assert!((params.dry - 0.2).abs() < f32::EPSILON);
        assert_eq!(params.sample_rate, 48000);
        assert_eq!(params.num_samples, 1000);
    }

    #[test]
    fn test_denoise_to_atten_lim_db() {
        assert!((denoise_to_atten_lim_db(0.0) - 0.0).abs() < f32::EPSILON);
        assert!((denoise_to_atten_lim_db(0.5) - 50.0).abs() < f32::EPSILON);
        assert!((denoise_to_atten_lim_db(1.0) - 100.0).abs() < f32::EPSILON);
    }

    #[test]
    fn test_dereverb_to_pf_beta() {
        assert!((dereverb_to_pf_beta(0.0) - 0.0).abs() < f32::EPSILON);
        assert!((dereverb_to_pf_beta(0.5) - 0.025).abs() < f32::EPSILON);
        assert!((dereverb_to_pf_beta(1.0) - 0.05).abs() < f32::EPSILON);
    }

    #[test]
    fn test_dry_wet_mix_all_dry() {
        let original = vec![1.0, 0.5, -0.5];
        let processed = vec![0.0, 0.0, 0.0];
        let result = apply_dry_wet_mix(&original, &processed, 1.0);
        for (r, &o) in result.iter().zip(original.iter()) {
            assert!((r - o).abs() < f32::EPSILON);
        }
    }

    #[test]
    fn test_dry_wet_mix_all_wet() {
        let original = vec![1.0, 0.5, -0.5];
        let processed = vec![0.0, 0.0, 0.0];
        let result = apply_dry_wet_mix(&original, &processed, 0.0);
        for (r, &p) in result.iter().zip(processed.iter()) {
            assert!((r - p).abs() < f32::EPSILON);
        }
    }

    #[test]
    fn test_dry_wet_mix_half() {
        let original = vec![1.0, 0.0];
        let processed = vec![0.0, 1.0];
        let result = apply_dry_wet_mix(&original, &processed, 0.5);
        assert!((result[0] - 0.5).abs() < f32::EPSILON);
        assert!((result[1] - 0.5).abs() < f32::EPSILON);
    }
}
