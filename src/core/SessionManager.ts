import type {
  Timeline,
  SessionData,
  SessionAudioFile,
  SessionTrack,
  SessionClip,
  Track,
  Clip,
  TrackInsert,
  PluginParameter,
  SerializedTrackInsert,
} from './types';

/**
 * Compute relative path from sessionFilePath's directory to targetPath.
 */
export function resolveRelativePath(sessionFilePath: string, targetPath: string): string {
  const sessionDir = sessionFilePath.substring(0, sessionFilePath.lastIndexOf('/'));
  const sessionParts = sessionDir.split('/');
  const targetParts = targetPath.split('/');

  // Find common prefix length
  let common = 0;
  while (
    common < sessionParts.length &&
    common < targetParts.length &&
    sessionParts[common] === targetParts[common]
  ) {
    common++;
  }

  const ups = sessionParts.length - common;
  const rest = targetParts.slice(common);
  const parts = [...Array(ups).fill('..'), ...rest];
  return parts.join('/');
}

/**
 * Resolve a relative path against a session file location, producing an absolute path.
 */
export function resolveAbsolutePath(sessionFilePath: string, relativePath: string): string {
  const sessionDir = sessionFilePath.substring(0, sessionFilePath.lastIndexOf('/'));
  const parts = sessionDir.split('/');
  for (const seg of relativePath.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

interface BufferSourceInfo {
  fileName: string;       // absolute path of source audio file
  channelIndex: number;   // which channel in that file
  sampleRate?: number;
  numSamples?: number;
  numChannels?: number;
}

/**
 * Serialize the current session state to a SessionData object (JSON-serializable).
 * Audio files are deduplicated by absolute path.
 */
export function serializeSession(
  timeline: Timeline,
  bufferSourceMap: Map<string, BufferSourceInfo>,
  sessionFilePath: string | null,
  metadata: Record<string, unknown>,
  fileBrowserPath: string | null,
): SessionData {
  // 1. Collect unique audio files from all clips
  const audioFileMap = new Map<string, SessionAudioFile>(); // keyed by absolutePath
  let afIdCounter = 0;

  function getOrCreateAudioFile(absolutePath: string, info: BufferSourceInfo): SessionAudioFile {
    let af = audioFileMap.get(absolutePath);
    if (!af) {
      af = {
        id: `af-${++afIdCounter}`,
        relativePath: sessionFilePath
          ? resolveRelativePath(sessionFilePath, absolutePath)
          : absolutePath,
        absolutePath,
        sampleRate: info.sampleRate ?? timeline.sampleRate,
        channels: info.numChannels ?? 1,
        numSamples: info.numSamples ?? 0,
      };
      audioFileMap.set(absolutePath, af);
    }
    return af;
  }

  // 2. Serialize tracks
  const sessionTracks: SessionTrack[] = timeline.tracks.map((track: Track) => {
    const sessionClips: SessionClip[] = track.clips.map((clip: Clip) => {
      let audioFileId = '';
      const channelIndices: number[] = [];

      for (const bufferId of clip.bufferIds) {
        const info = bufferSourceMap.get(bufferId);
        if (info) {
          const af = getOrCreateAudioFile(info.fileName, info);
          audioFileId = af.id;
          channelIndices.push(info.channelIndex);
          // Update audio file channel count if needed
          if (info.channelIndex + 1 > af.channels) {
            af.channels = info.channelIndex + 1;
          }
        }
      }

      return {
        id: clip.id,
        audioFileId,
        channelIndices,
        name: clip.name,
        timelineOffset: clip.timelineOffset,
        sourceStart: clip.sourceStart,
        sourceEnd: clip.sourceEnd,
        duration: clip.duration,
        gainDb: clip.gainDb,
        fadeInSamples: clip.fadeInSamples,
        fadeOutSamples: clip.fadeOutSamples,
        fadeInCurve: clip.fadeInCurve ?? 0,
        fadeOutCurve: clip.fadeOutCurve ?? 0,
        muted: clip.muted,
        reversed: clip.reversed ?? false,
        crossfadeInSamples: clip.crossfadeInSamples ?? 0,
        crossfadeOutSamples: clip.crossfadeOutSamples ?? 0,
        crossfadeType: clip.crossfadeType ?? 'equalPower',
      };
    });

    // Serialize inserts (reuse existing SerializedTrackInsert format)
    const inserts: SerializedTrackInsert[] = track.inserts.map((ins: TrackInsert) => ({
      pluginId: ins.pluginId,
      parameters: ins.parameters.map((p: PluginParameter) => ({
        id: p.id,
        name: p.name,
        value: p.value,
        min: p.min,
        max: p.max,
        defaultValue: p.defaultValue,
        ...(p.unit !== undefined ? { unit: p.unit } : {}),
      })),
      bypassed: ins.bypassed,
    }));

    return {
      id: track.id,
      name: track.name,
      color: track.color,
      channels: track.channels,
      volume: track.volume,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      channelIndex: track.channelIndex,
      height: track.height,
      clips: sessionClips,
      inserts,
    };
  });

  return {
    version: 1,
    app: 'FieldCorder',
    savedAt: new Date().toISOString(),
    sampleRate: timeline.sampleRate,
    playheadSample: timeline.playheadSample,
    fileBrowserPath,
    metadata,
    audioFiles: Array.from(audioFileMap.values()),
    tracks: sessionTracks,
  };
}

interface AudioFileToLoad {
  id: string;
  relativePath: string;
  absolutePath: string;
  sampleRate: number;
  channels: number;
  numSamples: number;
}

interface DeserializedSession {
  timeline: Timeline;
  metadata: Record<string, unknown>;
  fileBrowserPath: string | null;
  audioFilesToLoad: AudioFileToLoad[];
}

/**
 * Deserialize a SessionData object back into a Timeline.
 * Clips receive placeholder bufferIds like "af-1:0" that must be replaced
 * with real buffer pool IDs after audio files are loaded.
 */
export function deserializeSession(session: SessionData): DeserializedSession {
  const audioFilesToLoad: AudioFileToLoad[] = session.audioFiles.map(af => ({
    id: af.id,
    relativePath: af.relativePath,
    absolutePath: af.absolutePath,
    sampleRate: af.sampleRate,
    channels: af.channels,
    numSamples: af.numSamples,
  }));

  const tracks: Track[] = session.tracks.map(st => {
    const clips: Clip[] = st.clips.map(sc => ({
      id: sc.id,
      // Placeholder bufferIds: "af-1:0", "af-1:1" etc.
      // Will be replaced with real buffer pool IDs after audio loading
      bufferIds: sc.channelIndices.map(ch => `${sc.audioFileId}:${ch}`),
      name: sc.name,
      timelineOffset: sc.timelineOffset,
      sourceStart: sc.sourceStart,
      sourceEnd: sc.sourceEnd,
      duration: sc.duration,
      gainDb: sc.gainDb,
      fadeInSamples: sc.fadeInSamples,
      fadeOutSamples: sc.fadeOutSamples,
      fadeInCurve: sc.fadeInCurve,
      fadeOutCurve: sc.fadeOutCurve,
      muted: sc.muted,
      reversed: sc.reversed,
      crossfadeInSamples: sc.crossfadeInSamples,
      crossfadeOutSamples: sc.crossfadeOutSamples,
      crossfadeType: sc.crossfadeType,
    }));

    const inserts: TrackInsert[] = st.inserts.map(si => ({
      instanceId: '',  // Will be assigned when plugins are created
      pluginId: si.pluginId,
      parameters: si.parameters.map((p): PluginParameter => ({ ...p })),
      bypassed: si.bypassed,
    }));

    return {
      id: st.id,
      name: st.name,
      color: st.color,
      channels: st.channels,
      clips,
      volume: st.volume,
      pan: st.pan,
      mute: st.mute,
      solo: st.solo,
      channelIndex: st.channelIndex,
      inserts,
      height: st.height,
    };
  });

  const totalLength = tracks.reduce((max, t) => {
    for (const c of t.clips) {
      const end = c.timelineOffset + c.duration;
      if (end > max) max = end;
    }
    return max;
  }, 0);

  const timeline: Timeline = {
    sampleRate: session.sampleRate,
    totalLength,
    tracks,
    playheadSample: session.playheadSample,
    selectionStart: null,
    selectionEnd: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    samplesPerPixel: 100,
    scrollOffset: 0,
  };

  return {
    timeline,
    metadata: session.metadata,
    fileBrowserPath: session.fileBrowserPath,
    audioFilesToLoad,
  };
}
