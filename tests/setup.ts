// Global test setup — Web Audio API mocks for jsdom
import { afterEach, vi } from 'vitest';

// ==================== Mock AudioParam ====================

class MockAudioParam {
  value: number;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: string = 'a-rate';
  _events: { type: string; value: number; time: number }[] = [];

  constructor(defaultValue = 0, min = -3.4028235e38, max = 3.4028235e38) {
    this.value = defaultValue;
    this.defaultValue = defaultValue;
    this.minValue = min;
    this.maxValue = max;
  }

  setValueAtTime(value: number, time: number): MockAudioParam {
    this.value = value;
    this._events.push({ type: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): MockAudioParam {
    this.value = value;
    this._events.push({ type: 'ramp', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, _time: number): MockAudioParam {
    this.value = value;
    return this;
  }

  setTargetAtTime(target: number, _startTime: number, _timeConstant: number): MockAudioParam {
    this.value = target;
    return this;
  }

  cancelScheduledValues(_startTime: number): MockAudioParam {
    this._events = [];
    return this;
  }

  /** Evaluate automation value at a given time (for mock rendering). */
  _evaluate(time: number): number {
    if (this._events.length === 0) return this.value;

    let val = this.defaultValue;

    for (let i = 0; i < this._events.length; i++) {
      const ev = this._events[i];

      if (ev.time > time) {
        // Future event — check if it's a ramp we're interpolating into
        if (ev.type === 'ramp' && i > 0) {
          const prev = this._events[i - 1];
          const duration = ev.time - prev.time;
          const elapsed = time - prev.time;
          if (elapsed >= 0 && duration > 0) {
            val = prev.value + (ev.value - prev.value) * (elapsed / duration);
          }
        }
        break;
      }

      // Event is at or before query time
      val = ev.value;
    }

    return val;
  }
}

// ==================== Mock AudioNode Base ====================

class MockAudioNode {
  context: MockAudioContext;
  numberOfInputs = 1;
  numberOfOutputs = 1;
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  _connections: MockAudioNode[] = [];
  _connectionMeta: { dest: MockAudioNode; outIdx?: number; inIdx?: number }[] = [];

  constructor(context: MockAudioContext) {
    this.context = context;
  }

  connect(destination: any, outputIndex?: number, inputIndex?: number): any {
    this._connections.push(destination);
    this._connectionMeta.push({ dest: destination, outIdx: outputIndex, inIdx: inputIndex });
    return destination;
  }

  disconnect(destination?: any): void {
    if (destination) {
      const idx = this._connections.indexOf(destination);
      if (idx >= 0) {
        this._connections.splice(idx, 1);
        this._connectionMeta.splice(idx, 1);
      }
    } else {
      this._connections = [];
      this._connectionMeta = [];
    }
  }
}

// ==================== Specific Node Mocks ====================

class MockGainNode extends MockAudioNode {
  gain: MockAudioParam;

  constructor(context: MockAudioContext) {
    super(context);
    this.gain = new MockAudioParam(1.0);
  }
}

class MockBiquadFilterNode extends MockAudioNode {
  type: BiquadFilterType = 'lowpass';
  frequency: MockAudioParam;
  detune: MockAudioParam;
  Q: MockAudioParam;
  gain: MockAudioParam;

  constructor(context: MockAudioContext) {
    super(context);
    this.frequency = new MockAudioParam(350, 0, 24000);
    this.detune = new MockAudioParam(0);
    this.Q = new MockAudioParam(1, 0.0001, 1000);
    this.gain = new MockAudioParam(0, -40, 40);
  }

  getFrequencyResponse(
    _frequencyArray: Float32Array,
    magResponseOutput: Float32Array,
    phaseResponseOutput: Float32Array
  ): void {
    magResponseOutput.fill(1);
    phaseResponseOutput.fill(0);
  }
}

class MockDelayNode extends MockAudioNode {
  delayTime: MockAudioParam;

  constructor(context: MockAudioContext, maxDelayTime = 1.0) {
    super(context);
    this.delayTime = new MockAudioParam(0, 0, maxDelayTime);
  }
}

class MockDynamicsCompressorNode extends MockAudioNode {
  threshold: MockAudioParam;
  knee: MockAudioParam;
  ratio: MockAudioParam;
  attack: MockAudioParam;
  release: MockAudioParam;
  reduction = 0;

  constructor(context: MockAudioContext) {
    super(context);
    this.threshold = new MockAudioParam(-24, -100, 0);
    this.knee = new MockAudioParam(30, 0, 40);
    this.ratio = new MockAudioParam(12, 1, 20);
    this.attack = new MockAudioParam(0.003, 0, 1);
    this.release = new MockAudioParam(0.25, 0, 1);
  }
}

class MockConvolverNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
  normalize = true;

  constructor(context: MockAudioContext) {
    super(context);
  }
}

class MockAnalyserNode extends MockAudioNode {
  fftSize = 2048;
  frequencyBinCount = 1024;
  minDecibels = -100;
  maxDecibels = -30;
  smoothingTimeConstant = 0.8;

  constructor(context: MockAudioContext) {
    super(context);
  }

  getByteFrequencyData(array: Uint8Array): void {
    array.fill(0);
  }

  getByteTimeDomainData(array: Uint8Array): void {
    array.fill(128);
  }

  getFloatFrequencyData(array: Float32Array): void {
    array.fill(-100);
  }

  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(0);
  }
}

class MockAudioBufferSourceNode extends MockAudioNode {
  buffer: MockAudioBuffer | null = null;
  playbackRate: MockAudioParam;
  detune: MockAudioParam;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  _started = false;
  private _stopped = false;
  _when = 0;
  _offset = 0;
  _duration = 0;

  constructor(context: MockAudioContext) {
    super(context);
    this.playbackRate = new MockAudioParam(1.0);
    this.detune = new MockAudioParam(0);
  }

  start(when = 0, offset = 0, duration?: number): void {
    if (this._started) throw new Error('Cannot start an AudioBufferSourceNode more than once');
    this._started = true;
    this._when = when;
    this._offset = offset;
    this._duration = duration ?? (this.buffer ? this.buffer.duration - offset : 0);
  }

  stop(when?: number): void {
    if (!this._started) throw new Error('Cannot stop an AudioBufferSourceNode that has not been started');
    if (this._stopped) return;
    this._stopped = true;
  }
}

class MockStereoPannerNode extends MockAudioNode {
  pan: MockAudioParam;

  constructor(context: MockAudioContext) {
    super(context);
    this.pan = new MockAudioParam(0, -1, 1);
  }
}

class MockChannelSplitterNode extends MockAudioNode {
  constructor(context: MockAudioContext, numberOfOutputs = 6) {
    super(context);
    this.numberOfOutputs = numberOfOutputs;
  }
}

class MockChannelMergerNode extends MockAudioNode {
  constructor(context: MockAudioContext, numberOfInputs = 6) {
    super(context);
    this.numberOfInputs = numberOfInputs;
  }
}

// ==================== Mock AudioBuffer ====================

class MockAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  private _channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this._channels = [];
    for (let i = 0; i < numberOfChannels; i++) {
      this._channels.push(new Float32Array(length));
    }
  }

  getChannelData(channel: number): Float32Array {
    if (channel < 0 || channel >= this.numberOfChannels) {
      throw new Error(`Channel index ${channel} out of range`);
    }
    return this._channels[channel];
  }

  copyFromChannel(destination: Float32Array, channelNumber: number, startInChannel = 0): void {
    const source = this._channels[channelNumber];
    destination.set(source.subarray(startInChannel, startInChannel + destination.length));
  }

  copyToChannel(source: Float32Array, channelNumber: number, startInChannel = 0): void {
    this._channels[channelNumber].set(source, startInChannel);
  }
}

// ==================== Mock AudioDestinationNode ====================

class MockAudioDestinationNode extends MockAudioNode {
  maxChannelCount = 2;

  constructor(context: MockAudioContext) {
    super(context);
  }
}

// ==================== Mock OfflineAudioContext ====================

class MockOfflineAudioContext {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  destination: MockAudioDestinationNode;
  currentTime = 0;
  state: AudioContextState = 'suspended';
  _sources: MockAudioBufferSourceNode[] = [];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.destination = new MockAudioDestinationNode(null as any);
    this.destination.context = this as any;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(numberOfChannels, length, sampleRate);
  }

  createGain(): MockGainNode { return new MockGainNode(this as any); }
  createBiquadFilter(): MockBiquadFilterNode { return new MockBiquadFilterNode(this as any); }
  createDelay(max = 1.0): MockDelayNode { return new MockDelayNode(this as any, max); }
  createDynamicsCompressor(): MockDynamicsCompressorNode { return new MockDynamicsCompressorNode(this as any); }
  createConvolver(): MockConvolverNode { return new MockConvolverNode(this as any); }
  createAnalyser(): MockAnalyserNode { return new MockAnalyserNode(this as any); }
  createStereoPanner(): MockStereoPannerNode { return new MockStereoPannerNode(this as any); }
  createChannelSplitter(n = 6): MockChannelSplitterNode { return new MockChannelSplitterNode(this as any, n); }
  createChannelMerger(n = 6): MockChannelMergerNode { return new MockChannelMergerNode(this as any, n); }

  createBufferSource(): MockAudioBufferSourceNode {
    const src = new MockAudioBufferSourceNode(this as any);
    this._sources.push(src);
    return src;
  }

  /** Walk connection chain from a node, collecting gain/pan/merger info. */
  private _walkChain(start: MockAudioNode): {
    gains: MockGainNode[];
    panNode: MockStereoPannerNode | null;
    mergerInputIndex: number | null;
  } {
    const gains: MockGainNode[] = [];
    let panNode: MockStereoPannerNode | null = null;
    let mergerInputIndex: number | null = null;
    let current: MockAudioNode | null = start;
    const visited = new Set<MockAudioNode>();

    while (current && !visited.has(current)) {
      visited.add(current);
      if (current instanceof MockGainNode && current !== start) {
        gains.push(current);
      } else if (current instanceof MockStereoPannerNode) {
        panNode = current;
      }
      if (current._connectionMeta.length > 0) {
        const meta: { dest: MockAudioNode; outIdx?: number; inIdx?: number } = current._connectionMeta[0];
        if (meta.dest instanceof MockChannelMergerNode && meta.inIdx != null) {
          mergerInputIndex = meta.inIdx;
        }
        current = meta.dest;
      } else {
        current = null;
      }
    }
    return { gains, panNode, mergerInputIndex };
  }

  /** Simulate offline rendering by processing all scheduled sources. */
  async startRendering(): Promise<MockAudioBuffer> {
    const output = new MockAudioBuffer(this.numberOfChannels, this.length, this.sampleRate);

    for (const source of this._sources) {
      if (!source._started || !source.buffer) continue;

      const startSample = Math.round(source._when * this.sampleRate);
      const offsetSample = Math.round(source._offset * this.sampleRate);
      const durationSamples = Math.min(
        Math.round(source._duration * this.sampleRate),
        source.buffer.length - offsetSample,
      );

      const { gains, panNode, mergerInputIndex } = this._walkChain(source);

      const srcChannels = source.buffer.numberOfChannels;

      // For multi-channel source buffers: write each channel directly to the corresponding
      // output channel (after applying gain). This models multi-channel clip routing where
      // each channel of the combined buffer maps 1:1 to the output channel.
      if (srcChannels > 1 && mergerInputIndex == null) {
        for (let i = 0; i < durationSamples; i++) {
          const outIdx = startSample + i;
          if (outIdx < 0 || outIdx >= this.length) continue;
          const srcIdx = offsetSample + i;
          if (srcIdx < 0 || srcIdx >= source.buffer.length) continue;

          const time = outIdx / this.sampleRate;
          let gainMult = 1.0;
          for (const gn of gains) {
            gainMult *= gn.gain._evaluate(time);
          }

          for (let ch = 0; ch < Math.min(srcChannels, this.numberOfChannels); ch++) {
            let sample = source.buffer.getChannelData(ch)[srcIdx];
            output.getChannelData(ch)[outIdx] += sample * gainMult;
          }
        }
        continue;
      }

      for (let i = 0; i < durationSamples; i++) {
        const outIdx = startSample + i;
        if (outIdx < 0 || outIdx >= this.length) continue;
        const srcIdx = offsetSample + i;
        if (srcIdx < 0 || srcIdx >= source.buffer.length) continue;

        const time = outIdx / this.sampleRate;
        let sample = source.buffer.getChannelData(0)[srcIdx];

        // Apply all gain nodes in the chain
        for (const gn of gains) {
          sample *= gn.gain._evaluate(time);
        }

        // Route to output
        if (mergerInputIndex != null) {
          // Sub-channel via ChannelMerger — write to that channel
          if (mergerInputIndex < this.numberOfChannels) {
            output.getChannelData(mergerInputIndex)[outIdx] += sample;
          }
        } else if (panNode && this.numberOfChannels >= 2) {
          // Apply equal-power pan law (W3C StereoPannerNode algorithm)
          const p = panNode.pan._evaluate(time);
          const x = (p + 1) / 2; // 0..1
          const gainL = Math.cos(x * Math.PI / 2);
          const gainR = Math.sin(x * Math.PI / 2);
          output.getChannelData(0)[outIdx] += sample * gainL;
          output.getChannelData(1)[outIdx] += sample * gainR;
        } else {
          // No pan, no merger — write to channel 0
          output.getChannelData(0)[outIdx] += sample;
        }
      }
    }

    return output;
  }
}

// ==================== Mock AudioContext ====================

let _mockCurrentTime = 0;

class MockAudioContext {
  destination: MockAudioDestinationNode;
  sampleRate = 44100;
  state: AudioContextState = 'suspended';
  currentTime: number;

  constructor() {
    this.destination = new MockAudioDestinationNode(this);
    this.currentTime = _mockCurrentTime;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }

  async suspend(): Promise<void> {
    this.state = 'suspended';
  }

  createGain(): MockGainNode {
    return new MockGainNode(this);
  }

  createBiquadFilter(): MockBiquadFilterNode {
    return new MockBiquadFilterNode(this);
  }

  createDelay(maxDelayTime = 1.0): MockDelayNode {
    return new MockDelayNode(this, maxDelayTime);
  }

  createDynamicsCompressor(): MockDynamicsCompressorNode {
    return new MockDynamicsCompressorNode(this);
  }

  createConvolver(): MockConvolverNode {
    return new MockConvolverNode(this);
  }

  createAnalyser(): MockAnalyserNode {
    return new MockAnalyserNode(this);
  }

  createBufferSource(): MockAudioBufferSourceNode {
    return new MockAudioBufferSourceNode(this);
  }

  createStereoPanner(): MockStereoPannerNode {
    return new MockStereoPannerNode(this);
  }

  createChannelSplitter(numberOfOutputs = 6): MockChannelSplitterNode {
    return new MockChannelSplitterNode(this, numberOfOutputs);
  }

  createChannelMerger(numberOfInputs = 6): MockChannelMergerNode {
    return new MockChannelMergerNode(this, numberOfInputs);
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(numberOfChannels, length, sampleRate);
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer): Promise<MockAudioBuffer> {
    // Return a simple stereo buffer for tests
    return new MockAudioBuffer(2, 44100, 44100);
  }
}

// ==================== Mock ResizeObserver ====================

class MockResizeObserver {
  callback: ResizeObserverCallback;
  observedElements: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.observedElements.push(target);
  }

  unobserve(target: Element): void {
    this.observedElements = this.observedElements.filter(el => el !== target);
  }

  disconnect(): void {
    this.observedElements = [];
  }
}

// ==================== Mock CanvasRenderingContext2D ====================

class MockCanvasRenderingContext2D {
  canvas: HTMLCanvasElement;
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000000';
  lineWidth = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  globalAlpha = 1.0;
  shadowColor = 'rgba(0, 0, 0, 0)';
  shadowBlur = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  // Drawing
  fillRect(_x: number, _y: number, _w: number, _h: number): void {}
  strokeRect(_x: number, _y: number, _w: number, _h: number): void {}
  clearRect(_x: number, _y: number, _w: number, _h: number): void {}
  fillText(_text: string, _x: number, _y: number): void {}
  strokeText(_text: string, _x: number, _y: number): void {}

  // Path
  beginPath(): void {}
  closePath(): void {}
  moveTo(_x: number, _y: number): void {}
  lineTo(_x: number, _y: number): void {}
  quadraticCurveTo(_cpx: number, _cpy: number, _x: number, _y: number): void {}
  bezierCurveTo(_cp1x: number, _cp1y: number, _cp2x: number, _cp2y: number, _x: number, _y: number): void {}
  arc(_x: number, _y: number, _r: number, _s: number, _e: number): void {}
  rect(_x: number, _y: number, _w: number, _h: number): void {}
  stroke(): void {}
  fill(): void {}
  clip(): void {}

  // Transform
  setTransform(_a: number, _b: number, _c: number, _d: number, _e: number, _f: number): void {}
  translate(_x: number, _y: number): void {}
  rotate(_angle: number): void {}
  scale(_x: number, _y: number): void {}
  save(): void {}
  restore(): void {}

  // Line style
  setLineDash(_segments: number[]): void {}
  getLineDash(): number[] { return []; }

  // Gradient
  createLinearGradient(_x0: number, _y0: number, _x1: number, _y1: number): CanvasGradient {
    return { addColorStop() {} } as unknown as CanvasGradient;
  }
  createRadialGradient(_x0: number, _y0: number, _r0: number, _x1: number, _y1: number, _r1: number): CanvasGradient {
    return { addColorStop() {} } as unknown as CanvasGradient;
  }

  // ImageData
  createImageData(width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(Math.max(0, width * height * 4));
    return { data, width, height, colorSpace: 'srgb' as PredefinedColorSpace } as ImageData;
  }
  putImageData(_imageData: ImageData, _dx: number, _dy: number): void {}
  getImageData(_sx: number, _sy: number, sw: number, sh: number): ImageData {
    return this.createImageData(sw, sh);
  }

  // Measurement
  measureText(_text: string): TextMetrics {
    return { width: 0 } as TextMetrics;
  }

  drawImage(): void {}
  isPointInPath(): boolean { return false; }
}

// ==================== Mock Worker ====================

class MockWorker implements EventTarget {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  constructor(_url?: string | URL, _options?: WorkerOptions) {}

  postMessage(_data: unknown, _transfer?: Transferable[]): void {}
  terminate(): void {}
  addEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {}
  removeEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {}
  dispatchEvent(_event: Event): boolean { return true; }
}

// ==================== Install Global Mocks ====================

// Expose mock classes for test assertions
export {
  MockAudioContext,
  MockAudioBuffer,
  MockAudioParam,
  MockGainNode,
  MockBiquadFilterNode,
  MockDelayNode,
  MockDynamicsCompressorNode,
  MockConvolverNode,
  MockAnalyserNode,
  MockAudioBufferSourceNode,
  MockStereoPannerNode,
  MockChannelSplitterNode,
  MockChannelMergerNode,
  MockOfflineAudioContext,
  MockResizeObserver,
  MockCanvasRenderingContext2D,
  MockWorker,
};

// Helper to set mock currentTime for tests
export function setMockCurrentTime(time: number): void {
  _mockCurrentTime = time;
}

/**
 * Create a canvas element inside a parent div with mocked getBoundingClientRect.
 * Useful for renderer tests where jsdom doesn't perform layout.
 */
export function createMockCanvas(parentWidth = 800, parentHeight = 400): HTMLCanvasElement {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);

  parent.getBoundingClientRect = () => ({
    x: 0, y: 0,
    width: parentWidth, height: parentHeight,
    top: 0, right: parentWidth, bottom: parentHeight, left: 0,
    toJSON() {},
  } as DOMRect);

  return canvas;
}

// Assign to globalThis
(globalThis as any).AudioContext = MockAudioContext;
(globalThis as any).AudioBuffer = MockAudioBuffer;
(globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
(globalThis as any).AudioParam = MockAudioParam;
(globalThis as any).GainNode = MockGainNode;
(globalThis as any).BiquadFilterNode = MockBiquadFilterNode;
(globalThis as any).DelayNode = MockDelayNode;
(globalThis as any).DynamicsCompressorNode = MockDynamicsCompressorNode;
(globalThis as any).ConvolverNode = MockConvolverNode;
(globalThis as any).AnalyserNode = MockAnalyserNode;
(globalThis as any).AudioBufferSourceNode = MockAudioBufferSourceNode;
(globalThis as any).StereoPannerNode = MockStereoPannerNode;
(globalThis as any).ChannelSplitterNode = MockChannelSplitterNode;
(globalThis as any).ChannelMergerNode = MockChannelMergerNode;
(globalThis as any).ResizeObserver = MockResizeObserver;
(globalThis as any).Worker = MockWorker;

// Patch HTMLCanvasElement.getContext to return mock 2d context (jsdom returns null)
(HTMLCanvasElement.prototype as any).getContext = function (contextId: string): unknown {
  if (contextId === '2d') {
    return new MockCanvasRenderingContext2D(this);
  }
  return null;
};

// Mock requestAnimationFrame / cancelAnimationFrame
let _rafId = 0;
(globalThis as any).requestAnimationFrame = vi.fn((_cb: FrameRequestCallback) => ++_rafId);
(globalThis as any).cancelAnimationFrame = vi.fn((_id: number) => {});

// Cleanup after each test
afterEach(() => {
  document.body.innerHTML = '';
  _mockCurrentTime = 0;
});
