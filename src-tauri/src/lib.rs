use std::fs;
use std::path::PathBuf;
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
/// Supports: PCM 16-bit, 24-bit, 32-bit, and IEEE Float 32-bit.
#[tauri::command]
async fn read_audio_file(path: String) -> Result<AudioFileData, String> {
    let data = fs::read(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))?;

    if data.len() < 44 {
        return Err("File too small to be a valid WAV".into());
    }

    // Validate RIFF/WAVE header
    if &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("Not a valid WAV file (missing RIFF/WAVE header)".into());
    }

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

    Ok(AudioFileData {
        sample_rate,
        num_channels,
        num_samples,
        channels,
    })
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
        .item(&item!(handle, "normalize", "Normalize...", "CmdOrCtrl+Shift+N"))
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
            file_info,
            read_audio_file,
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
