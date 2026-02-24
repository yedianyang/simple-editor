// Global test setup — Web Audio API mocks for jsdom
import { afterEach, vi } from 'vitest';

// ==================== Mock AudioParam ====================

class MockAudioParam {
  value: number;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: string = 'a-rate';

  constructor(defaultValue = 0, min = -3.4028235e38, max = 3.4028235e38) {
    this.value = defaultValue;
    this.defaultValue = defaultValue;
    this.minValue = min;
    this.maxValue = max;
  }

  setValueAtTime(value: number, _time: number): MockAudioParam {
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, _time: number): MockAudioParam {
    this.value = value;
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
    return this;
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

  constructor(context: MockAudioContext) {
    this.context = context;
  }

  connect(destination: any, outputIndex?: number, inputIndex?: number): any {
    this._connections.push(destination);
    return destination;
  }

  disconnect(destination?: any): void {
    if (destination) {
      this._connections = this._connections.filter(n => n !== destination);
    } else {
      this._connections = [];
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
  private _started = false;
  private _stopped = false;

  constructor(context: MockAudioContext) {
    super(context);
    this.playbackRate = new MockAudioParam(1.0);
    this.detune = new MockAudioParam(0);
  }

  start(when?: number, offset?: number, duration?: number): void {
    if (this._started) throw new Error('Cannot start an AudioBufferSourceNode more than once');
    this._started = true;
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

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(numberOfChannels, length, sampleRate);
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
};

// Helper to set mock currentTime for tests
export function setMockCurrentTime(time: number): void {
  _mockCurrentTime = time;
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

// Mock requestAnimationFrame / cancelAnimationFrame
let _rafId = 0;
(globalThis as any).requestAnimationFrame = vi.fn((_cb: FrameRequestCallback) => ++_rafId);
(globalThis as any).cancelAnimationFrame = vi.fn((_id: number) => {});

// Cleanup after each test
afterEach(() => {
  document.body.innerHTML = '';
  _mockCurrentTime = 0;
});
