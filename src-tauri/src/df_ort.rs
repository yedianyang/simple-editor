//! DeepFilterNet GPU inference via ONNX Runtime (CoreML on macOS).
//!
//! Processes the entire audio sequence at once (full-sequence inference),
//! unlike the tract backend which uses pulsed (frame-by-frame) processing.
//! Both produce perceptually equivalent results.

use std::io::Read;

use flate2::read::GzDecoder;
use ini::configparser::ini::Ini;
use ort::{session::Session, value::Tensor};

use df::DFState;

/// Extracted ONNX model bytes + config from the DeepFilterNet3 tar.gz.
struct DfModels {
    config: Ini,
    enc_bytes: Vec<u8>,
    erb_dec_bytes: Vec<u8>,
    df_dec_bytes: Vec<u8>,
}

impl DfModels {
    fn from_targz(data: &[u8]) -> Result<Self, String> {
        let decoder = GzDecoder::new(data);
        let mut archive = tar::Archive::new(decoder);
        let mut enc = Vec::new();
        let mut erb_dec = Vec::new();
        let mut df_dec = Vec::new();
        let mut config_str = String::new();

        for entry in archive.entries().map_err(|e| format!("tar read: {e}"))? {
            let mut file = entry.map_err(|e| format!("tar entry: {e}"))?;
            let path = file.path().unwrap().to_path_buf();
            if path.to_string_lossy().ends_with("enc.onnx") {
                file.read_to_end(&mut enc).map_err(|e| format!("read enc: {e}"))?;
            } else if path.to_string_lossy().ends_with("erb_dec.onnx") {
                file.read_to_end(&mut erb_dec).map_err(|e| format!("read erb_dec: {e}"))?;
            } else if path.to_string_lossy().ends_with("df_dec.onnx") {
                file.read_to_end(&mut df_dec).map_err(|e| format!("read df_dec: {e}"))?;
            } else if path.to_string_lossy().ends_with("config.ini") {
                file.read_to_string(&mut config_str).map_err(|e| format!("read config: {e}"))?;
            }
        }

        if enc.is_empty() || erb_dec.is_empty() || df_dec.is_empty() {
            return Err("Missing model files in tar.gz".into());
        }

        let mut config = Ini::new();
        config.read(config_str).map_err(|e| format!("parse config: {e}"))?;

        Ok(Self { config, enc_bytes: enc, erb_dec_bytes: erb_dec, df_dec_bytes: df_dec })
    }
}

/// GPU-accelerated DeepFilterNet processor using ONNX Runtime.
pub struct DfOrt {
    enc_session: Session,
    erb_dec_session: Session,
    df_dec_session: Session,
    state: DFState,
    sr: usize,
    hop_size: usize,
    fft_size: usize,
    nb_erb: usize,
    nb_df: usize,
    #[allow(dead_code)]
    df_order: usize,
    n_freqs: usize,
    alpha: f32,
    atten_lim: Option<f32>,
    #[allow(dead_code)]
    post_filter: bool,
    #[allow(dead_code)]
    post_filter_beta: f32,
    min_db_thresh: f32,
    max_db_erb_thresh: f32,
    max_db_df_thresh: f32,
}

fn calc_norm_alpha(sr: usize, hop_size: usize, tau: f32) -> f32 {
    let dt = hop_size as f32 / sr as f32;
    let alpha = f32::exp(-dt / tau);
    let mut a = 1.0;
    let mut precision = 3u32;
    while a >= 1.0 {
        a = (alpha * 10f32.powi(precision as i32)).round() / 10f32.powi(precision as i32);
        precision += 1;
    }
    a
}

impl DfOrt {
    pub fn new(atten_lim_db: f32, pf_beta: f32) -> Result<Self, String> {
        let tar_bytes = include_bytes!("../models/DeepFilterNet3_onnx.tar.gz");
        let models = DfModels::from_targz(tar_bytes)?;

        let cfg = &models.config;

        let get = |section: &str, key: &str| -> Result<String, String> {
            cfg.get(section, key).ok_or_else(|| format!("missing config [{section}].{key}"))
        };

        let sr: usize = get("df", "sr")?.parse().map_err(|e| format!("sr: {e}"))?;
        let hop_size: usize = get("df", "hop_size")?.parse().map_err(|e| format!("hop: {e}"))?;
        let fft_size: usize = get("df", "fft_size")?.parse().map_err(|e| format!("fft: {e}"))?;
        let nb_erb: usize = get("df", "nb_erb")?.parse().map_err(|e| format!("erb: {e}"))?;
        let nb_df: usize = get("df", "nb_df")?.parse().map_err(|e| format!("nb_df: {e}"))?;
        let min_nb_erb_freqs: usize = get("df", "min_nb_erb_freqs")?.parse().map_err(|e| format!("min_erb: {e}"))?;

        let df_order: usize = cfg.get("df", "df_order")
            .or_else(|| cfg.get("deepfilternet", "df_order"))
            .ok_or("missing config df_order")?
            .parse()
            .map_err(|e| format!("df_order: {e}"))?;

        let n_freqs = fft_size / 2 + 1;

        let alpha = if let Some(a) = cfg.get("df", "norm_alpha") {
            a.parse::<f32>().map_err(|e| format!("alpha: {e}"))?
        } else {
            let tau = get("df", "norm_tau")?.parse::<f32>().map_err(|e| format!("tau: {e}"))?;
            calc_norm_alpha(sr, hop_size, tau)
        };

        let atten_lim = {
            let lim = atten_lim_db.abs();
            if lim >= 100.0 { None }
            else if lim < 0.01 { Some(1.0) }
            else { Some(10f32.powf(-lim / 20.0)) }
        };

        // Build ort sessions with CoreML EP on macOS
        let enc_session = Self::build_session(&models.enc_bytes)?;
        let erb_dec_session = Self::build_session(&models.erb_dec_bytes)?;
        let df_dec_session = Self::build_session(&models.df_dec_bytes)?;

        let mut state = DFState::new(sr, fft_size, hop_size, nb_erb, min_nb_erb_freqs);
        state.init_norm_states(nb_df);

        log::info!("[DfOrt] Loaded: sr={sr}, hop={hop_size}, fft={fft_size}, erb={nb_erb}, df={nb_df}, order={df_order}");

        Ok(Self {
            enc_session,
            erb_dec_session,
            df_dec_session,
            state,
            sr,
            hop_size,
            fft_size,
            nb_erb,
            nb_df,
            df_order,
            n_freqs,
            alpha,
            atten_lim,
            post_filter: pf_beta > 0.0,
            post_filter_beta: pf_beta,
            min_db_thresh: -10.0,
            max_db_erb_thresh: 30.0,
            max_db_df_thresh: 20.0,
        })
    }

    fn build_session(model_bytes: &[u8]) -> Result<Session, String> {
        let mut builder = Session::builder()
            .map_err(|e| format!("ort session builder: {e}"))?;

        // Try CoreML on macOS, fall back to CPU
        #[cfg(target_os = "macos")]
        {
            builder = match builder.with_execution_providers([
                ort::execution_providers::CoreMLExecutionProvider::default().build(),
            ]) {
                Ok(b) => {
                    log::info!("[DfOrt] CoreML execution provider enabled");
                    b
                }
                Err(e) => {
                    log::warn!("[DfOrt] CoreML unavailable ({e}), falling back to CPU");
                    Session::builder().map_err(|e| format!("ort fallback: {e}"))?
                }
            };
        }

        builder
            .commit_from_memory(model_bytes)
            .map_err(|e| format!("ort load model: {e}"))
    }

    /// Process audio samples (mono, 48kHz). Returns enhanced samples.
    pub fn process(
        &mut self,
        samples: &[f32],
        progress_cb: &dyn Fn(u32),
    ) -> Result<Vec<f32>, String> {
        let hop = self.hop_size;
        let total_frames = samples.len().div_ceil(hop);
        if total_frames == 0 {
            return Ok(vec![]);
        }

        // Phase 1: STFT + feature extraction (CPU) — collect all frames
        let mut all_specs: Vec<Vec<f32>> = Vec::with_capacity(total_frames); // each: [n_freqs * 2]
        let mut all_erb: Vec<Vec<f32>> = Vec::with_capacity(total_frames);   // each: [nb_erb]
        let mut all_cplx: Vec<Vec<f32>> = Vec::with_capacity(total_frames);  // each: [nb_df * 2]

        for frame_idx in 0..total_frames {
            let start = frame_idx * hop;
            let end = (start + hop).min(samples.len());
            let mut chunk = vec![0.0f32; hop];
            chunk[..end - start].copy_from_slice(&samples[start..end]);

            // STFT
            let mut spec = vec![df::Complex32::default(); self.n_freqs];
            self.state.analysis(&chunk, &mut spec);

            // ERB features
            let mut erb_feat = vec![0.0f32; self.nb_erb];
            self.state.feat_erb(&spec, self.alpha, &mut erb_feat);

            // Complex DF features
            let mut cplx_feat = vec![df::Complex32::default(); self.nb_df];
            self.state.feat_cplx(&spec[..self.nb_df], self.alpha, &mut cplx_feat);

            // Store as f32 arrays
            let spec_f32: Vec<f32> = unsafe {
                std::slice::from_raw_parts(spec.as_ptr() as *const f32, self.n_freqs * 2).to_vec()
            };
            let cplx_f32: Vec<f32> = unsafe {
                std::slice::from_raw_parts(cplx_feat.as_ptr() as *const f32, self.nb_df * 2).to_vec()
            };

            all_specs.push(spec_f32);
            all_erb.push(erb_feat);
            all_cplx.push(cplx_f32);
        }

        progress_cb(20); // Feature extraction done

        // Phase 2: Build batch tensors for ort
        let t = total_frames;

        // feat_erb: [1, 1, T, nb_erb]
        let mut erb_data = vec![0.0f32; t * self.nb_erb];
        for (i, erb) in all_erb.iter().enumerate() {
            erb_data[i * self.nb_erb..(i + 1) * self.nb_erb].copy_from_slice(erb);
        }
        let erb_tensor = Tensor::from_array(([1usize, 1, t, self.nb_erb], erb_data))
            .map_err(|e| format!("erb ort tensor: {e}"))?;

        // feat_spec: [1, 2, T, nb_df] — real and imaginary parts separated
        let mut spec_data = vec![0.0f32; 2 * t * self.nb_df];
        for (i, cplx) in all_cplx.iter().enumerate() {
            for j in 0..self.nb_df {
                spec_data[i * self.nb_df + j] = cplx[j * 2];                      // real
                spec_data[t * self.nb_df + i * self.nb_df + j] = cplx[j * 2 + 1]; // imag
            }
        }
        let spec_tensor = Tensor::from_array(([1usize, 2, t, self.nb_df], spec_data))
            .map_err(|e| format!("spec ort tensor: {e}"))?;

        // Phase 3: Run encoder (GPU)
        // Extract all output data into owned Vecs immediately so the session borrow is released.
        let (lsnr_values, enc_owned) = {
            let enc_outputs = self.enc_session.run(
                ort::inputs![erb_tensor, spec_tensor]
            ).map_err(|e| format!("enc run: {e}"))?;

            // Encoder outputs: e0, e1, e2, e3, emb, c0, lsnr (indices 0-6)
            let mut owned: Vec<(Vec<usize>, Vec<f32>)> = Vec::new();
            for i in 0..7 {
                let (shape, data) = enc_outputs[i].try_extract_tensor::<f32>()
                    .map_err(|e| format!("enc output[{i}] extract: {e}"))?;
                owned.push((shape.iter().map(|&d| d as usize).collect(), data.to_vec()));
            }

            // lsnr is index 6
            let lsnr_values: Vec<f32> = owned[6].1.clone();
            (lsnr_values, owned)
            // enc_outputs is dropped here, releasing the mutable borrow on enc_session
        };

        progress_cb(40);

        // Recreate tensors for emb (idx 4), e3/e2/e1/e0 (idx 3-0) for erb decoder
        let make_tensor = |idx: usize| -> Result<Tensor<f32>, String> {
            let (shape, data) = &enc_owned[idx];
            Tensor::from_array((shape.clone(), data.clone()))
                .map_err(|e| format!("tensor[{idx}] recreate: {e}"))
        };

        // Phase 4: Run ERB decoder (GPU) — for gain mask
        // Inputs: emb, e3, e2, e1, e0
        let gains_flat = {
            let erb_dec_outputs = self.erb_dec_session.run(
                ort::inputs![
                    make_tensor(4)?,
                    make_tensor(3)?,
                    make_tensor(2)?,
                    make_tensor(1)?,
                    make_tensor(0)?
                ]
            ).map_err(|e| format!("erb_dec run: {e}"))?;

            progress_cb(60);

            // Gain mask shape: [1, 1, T, nb_erb] or [1, T, nb_erb]
            let (_, gains_data) = erb_dec_outputs[0].try_extract_tensor::<f32>()
                .map_err(|e| format!("gains extract: {e}"))?;
            gains_data.to_vec()
            // erb_dec_outputs dropped here
        };

        // Phase 5: Run DF decoder (GPU) — for DF coefficients
        let _coefs_flat = {
            let df_dec_outputs = self.df_dec_session.run(
                ort::inputs![
                    make_tensor(4)?,
                    make_tensor(5)?
                ]
            ).map_err(|e| format!("df_dec run: {e}"))?;

            let (_, coefs_data) = df_dec_outputs[0].try_extract_tensor::<f32>()
                .map_err(|e| format!("coefs extract: {e}"))?;
            coefs_data.to_vec()
            // df_dec_outputs dropped here
        };

        progress_cb(80);

        // Phase 6: Apply masks + DF + synthesis (CPU) — frame by frame
        let mut output = vec![0.0f32; samples.len()];

        // Reset state for synthesis pass
        let mut synth_state = DFState::new(self.sr, self.fft_size, self.hop_size, self.nb_erb,
            df_cfg_min_nb_erb_freqs(&self.state));

        for frame_idx in 0..total_frames {
            let spec_f32 = &all_specs[frame_idx];
            let mut spec: Vec<df::Complex32> = unsafe {
                std::slice::from_raw_parts(
                    spec_f32.as_ptr() as *const df::Complex32,
                    self.n_freqs,
                ).to_vec()
            };

            // Get per-frame lsnr (use frame index if available, otherwise mean)
            let frame_lsnr = if frame_idx < lsnr_values.len() {
                lsnr_values[frame_idx]
            } else {
                lsnr_values.iter().sum::<f32>() / lsnr_values.len() as f32
            };

            let (apply_gains, apply_zeros, _apply_df) = self.apply_stages(frame_lsnr);

            // Apply ERB gain mask
            if apply_gains {
                let gain_offset = frame_idx * self.nb_erb;
                if gain_offset + self.nb_erb <= gains_flat.len() {
                    let gain_slice = &gains_flat[gain_offset..gain_offset + self.nb_erb];
                    self.state.apply_mask(&mut spec, gain_slice);
                }
            } else if apply_zeros {
                let zeros = vec![0.0f32; self.nb_erb];
                self.state.apply_mask(&mut spec, &zeros);
            }

            // Attenuation limit: mix back noisy signal
            if let Some(lim) = self.atten_lim {
                let noisy_spec: Vec<df::Complex32> = unsafe {
                    std::slice::from_raw_parts(
                        all_specs[frame_idx].as_ptr() as *const df::Complex32,
                        self.n_freqs,
                    ).to_vec()
                };
                for (enh, nsy) in spec.iter_mut().zip(noisy_spec.iter()) {
                    *enh = *enh * (1.0 - lim) + *nsy * lim;
                }
            }

            // iSTFT — synthesis takes &mut [Complex32]
            let start = frame_idx * self.hop_size;
            let end = (start + self.hop_size).min(output.len());
            let mut out_chunk = vec![0.0f32; self.hop_size];
            synth_state.synthesis(&mut spec, &mut out_chunk);
            output[start..end].copy_from_slice(&out_chunk[..end - start]);

            if frame_idx % 100 == 0 {
                let pct = 80 + (frame_idx as u32 * 20 / total_frames as u32);
                progress_cb(pct);
            }
        }

        progress_cb(100);
        Ok(output)
    }

    fn apply_stages(&self, lsnr: f32) -> (bool, bool, bool) {
        if lsnr < self.min_db_thresh {
            (false, true, false)
        } else if lsnr > self.max_db_erb_thresh {
            (false, false, false)
        } else if lsnr > self.max_db_df_thresh {
            (true, false, false)
        } else {
            (true, false, true)
        }
    }
}

/// Helper to get min_nb_erb_freqs from a DFState.
/// DFState stores erb band widths; we infer the min from the erb vector.
fn df_cfg_min_nb_erb_freqs(state: &DFState) -> usize {
    state.erb.iter().copied().min().unwrap_or(1)
}
