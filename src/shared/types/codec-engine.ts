export type CodecId =
  | 'flac'
  | 'lame'
  | 'opusenc'
  | 'opusdec'
  | 'oggenc'
  | 'wavpack'
  | 'wvunpack'
  | 'mpcenc'
  | 'mpcdec'
  | 'qaac'
  | 'refalac'
  | 'fhgaacenc'
  | 'fdkaac'
  | 'tak'
  | 'mac'
  | 'ffmpeg'
  | 'ffprobe'
  | 'alac-wasm';

export type CodecCategory =
  | 'encoder'
  | 'decoder'
  | 'transcoder'
  | 'analyzer'
  | 'supporting-dll';

export type CodecClassificationGroup =
  | 'default-encoder-pack'
  | 'additional-decoder'
  | 'optional-encoder'
  | 'ffmpeg'
  | 'ffprobe'
  | 'builtin-wasm'
  | 'supporting-dll';

export type CodecSourceTier =
  | 'builtin'
  | 'custom'
  | 'user-pack'
  | 'bundled'
  | 'system'
  | 'missing';

export type CodecTrustStatus =
  | 'trusted'
  | 'verified'
  | 'unverified'
  | 'missing'
  | 'invalid'
  | 'incompatible'
  | 'missing-dependency'
  | 'disabled'
  | 'pending-desktop-verification';

export type CodecHealthStatus =
  | 'ready'
  | 'detected'
  | 'verified'
  | 'unverified'
  | 'missing'
  | 'invalid'
  | 'incompatible'
  | 'missing-dependency'
  | 'disabled'
  | 'pending-desktop-verification'
  | 'outdated';

export type CodecBinaryArchitecture =
  | 'x64'
  | 'x86'
  | 'arm64'
  | 'universal'
  | 'script'
  | 'unknown';

export type CodecBinaryFormat = 'pe' | 'elf' | 'macho' | 'script' | 'unknown';

export type CodecRedistributionStatus =
  | 'redistributable'
  | 'user-supplied-only'
  | 'license-verification-required'
  | 'non-redistributable'
  | 'builtin';

export type ResourceMode = 'power-saving' | 'balanced' | 'performance';

export interface ResourceModePolicy {
  mode: ResourceMode;
  label: string;
  description: string;
  maxConversionConcurrency: number;
  maxEncoderThreads: number;
  maxProbeConcurrency: number;
  maxAnalyzerConcurrency: number;
  progressThrottleMs: number;
  deferNewJobsDuringPlayback: boolean;
  playbackConversionConcurrencyCap: number;
  playbackEncoderThreadsCap: number;
  deferProbeWhenPlaybackActive: boolean;
  deferHeavyAnalysisWhenPlaybackActive: boolean;
}

export interface PlaybackPriorityState {
  isPlaying: boolean;
  isBuffering?: boolean;
  activeTrackFormat?: string | null;
  updatedAt?: string;
}

export interface EffectiveResourceLimits {
  mode: ResourceMode;
  playbackPriorityActive: boolean;
  conversionConcurrency: number;
  encoderThreads: number;
  probeConcurrency: number;
  analyzerConcurrency: number;
  progressThrottleMs: number;
  deferNewConversionJobs: boolean;
  deferCodecScanning: boolean;
  deferHeavyAnalysis: boolean;
}

export type SourceSampleFormat = 'pcm-int' | 'pcm-float' | 'lossy' | 'unknown';

export interface SourceAudioSpec {
  codecName?: string | null;
  container?: string | null;
  sampleRateHz?: number | null;
  bitDepth?: number | null;
  validBitsPerSample?: number | null;
  sampleFormat?: SourceSampleFormat;
  rawSampleFmt?: string | null;
  channels?: number | null;
  channelLayout?: string | null;
  isLosslessCodec?: boolean | null;
  hasAttachedPic?: boolean;
  hasVideoStream?: boolean;
  durationSec?: number | null;
  tags?: Record<string, string>;
}

export interface FfmpegCapabilities {
  executablePath: string;
  detectedAt: string;
  encoders: string[];
  decoders: string[];
  formats: string[];
  sampleFormats: string[];
}

export interface CodecDependencySpec {
  name: string;
  kind: 'supporting-dll' | 'system-runtime';
  required: boolean;
  verificationStatus: 'verified' | 'pending-desktop-verification';
  description: string;
}

export interface CodecSupportingFileSpec {
  fileName: string;
  kind: 'supporting-dll' | 'license-file';
  includedInFoobarPack: boolean;
  relatedCodecs: CodecId[];
  license?: string;
  redistributionStatus: CodecRedistributionStatus;
  verificationStatus: 'verified' | 'pending-desktop-verification';
  description: string;
}

export interface CodecBinaryInspectionResult {
  valid: boolean;
  format: CodecBinaryFormat;
  architecture: CodecBinaryArchitecture;
  targetPlatform: 'win32' | 'linux' | 'darwin' | 'posix' | 'unknown';
  compatibleWithHost: boolean;
  executableInCurrentRuntime: boolean;
  sizeBytes: number;
  peMachineHex?: string;
  isPeDll?: boolean;
  reason?: string;
}

export interface CodecDiscoveryPolicy {
  maxProbeConcurrency: number;
  allowSystemPathLookup: boolean;
  deferProbeWhenPlaybackActive?: boolean;
}

export interface CustomCodecConsentRecord {
  codecId: CodecId;
  fileName: string;
  sha256: string;
  originNote: string;
  consentedAt: string;
  userConfirmed: boolean;
}

export interface CodecManifestEntry {
  id: CodecId;
  name: string;
  displayFormat: string;
  category: CodecCategory;
  group: CodecClassificationGroup;
  capabilities: Array<'encode' | 'decode' | 'probe' | 'stream-transcode'>;
  extensions: string[];
  winExecutableNames: string[];
  posixExecutableNames: string[];
  versionArgs: string[];
  acceptedVersionExitCodes?: number[];
  versionIdentityPatterns?: string[];
  license: string;
  licenseFile?: string | null;
  redistributionStatus: CodecRedistributionStatus;
  officialSource: string;
  expectedSha256: Partial<Record<string, string>> | null;
  supportedPlatforms: Array<'win32' | 'darwin' | 'linux'>;
  supportedArchitectures: CodecBinaryArchitecture[];
  requiredDependencies: CodecDependencySpec[];
  includedInFoobarPack: boolean;
  optional: boolean;
  description: string;
  officialHomepage: string;
}

export interface CodecRuntimeEntry {
  id: CodecId;
  name: string;
  displayFormat: string;
  category: CodecCategory;
  group: CodecClassificationGroup;
  capabilities: Array<'encode' | 'decode' | 'probe' | 'stream-transcode'>;
  extensions: string[];
  license: string;
  licenseFile: string | null;
  redistributionStatus: CodecRedistributionStatus;
  includedInFoobarPack: boolean;
  optional: boolean;
  description: string;
  status: CodecHealthStatus;
  trustStatus: CodecTrustStatus;
  sourceTier: CodecSourceTier;
  executablePath: string | null;
  version: string | null;
  sha256: string | null;
  fileSizeBytes: number | null;
  binaryFormat: CodecBinaryFormat | null;
  architecture: CodecBinaryArchitecture | null;
  checksumVerified: boolean;
  userConsentGranted: boolean;
  missingDependencies: string[];
  fallbackUsed?: boolean;
  fallbackWarnings?: string[];
  lastCheckedAt: string;
  errorMessage?: string;
}

export interface CodecPackMetadata {
  packName: string;
  manifestVersion: string;
  compatiblePackDate: string;
  installedPackVersion: string | null;
  installedPackDate: string | null;
  installedPackSource: 'bundled' | 'user-pack' | 'none';
  installedLicenseFiles: string[];
  installedSupportingDlls: string[];
  hasRollbackSnapshot: boolean;
  codecsDirectory: string;
}

export interface CodecInventorySnapshot {
  platform: string;
  arch: string;
  generatedAt: string;
  pack: CodecPackMetadata;
  codecs: CodecRuntimeEntry[];
  summary: {
    total: number;
    ready: number;
    pendingDesktopVerification: number;
    unverified: number;
    missingDependency: number;
    encodersReady: number;
    decodersReady: number;
    ffmpegReady: boolean;
    ffprobeReady: boolean;
  };
}

export type ConvertTargetFormat =
  | 'flac'
  | 'wav'
  | 'alac'
  | 'mp3'
  | 'opus'
  | 'ogg'
  | 'aac'
  | 'wv'
  | 'mpc';

export type ConflictPolicy = 'rename' | 'skip' | 'overwrite';

export type BitDepthOption = 'source' | 16 | 24 | 32;
export type SampleRateOption = 'source' | 44100 | 48000 | 88200 | 96000 | 192000;
export type ChannelOption = 'source' | 1 | 2;
export type Mp3RateMode = 'vbr' | 'cbr';

export interface AudioConvertOptions {
  targetFormat: ConvertTargetFormat;
  /** FLAC 0..8 */
  flacCompressionLevel: number;
  /** FLAC -V verification */
  flacVerify: boolean;
  /** MP3 VBR/CBR mode */
  mp3Mode: Mp3RateMode;
  /** MP3 VBR quality 0 (best) .. 6 */
  mp3VbrQuality: number;
  /** Bitrate in kbps for CBR MP3 / Opus / AAC (64..320) */
  bitrateKbps: number;
  /** Vorbis Q0..Q10 */
  vorbisQuality: number;
  /** WavPack mode: fast | normal | high | extra */
  wavpackMode: 'fast' | 'normal' | 'high' | 'extra';
  /** Musepack SV8 quality 0..10 (default 5 = standard) */
  musepackQuality?: number;
  sampleRateHz: SampleRateOption;
  bitDepth: BitDepthOption;
  channels: ChannelOption;
  preserveMetadata: boolean;
  preserveArtwork: boolean;
  conflictPolicy: ConflictPolicy;
  outputDirectory: string | null;
  autoImportToLibrary: boolean;
  preferNativeEncoder: boolean;
  concurrency: number;
  resourceMode?: ResourceMode;
  maxThreads?: number | null;
  verifyPcmOnLossless?: boolean;
}

export interface ConversionPreset {
  id: string;
  name: string;
  subtitle: string;
  category: 'lossless' | 'portable' | 'universal' | 'studio';
  options: Partial<AudioConvertOptions> & { targetFormat: ConvertTargetFormat };
}

export type ConversionJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'skipped';

export type ConversionProgressMode = 'determinate' | 'indeterminate';

export type OutputVerificationStatus =
  | 'verified-full'
  | 'verified-container-only'
  | 'unverified-no-ffprobe'
  | 'failed';

export type PcmComparisonStatus =
  | 'matched'
  | 'mismatch'
  | 'skipped-lossy'
  | 'skipped-dsp-changed'
  | 'skipped-no-ffmpeg'
  | 'failed'
  | 'not-requested';

export type ProcessTerminationReason =
  | 'completed'
  | 'canceled'
  | 'startup-timeout'
  | 'inactivity-timeout'
  | 'error'
  | 'disposed';

export interface OutputVerificationReport {
  status: OutputVerificationStatus;
  fileExists: boolean;
  fileSizeBytes: number;
  containerHeaderValid: boolean;
  detectedContainer: string | null;
  audioStreamFound: boolean | null;
  codecName: string | null;
  durationSec: number | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
  pcmComparisonStatus: PcmComparisonStatus;
  pcmComparisonNote?: string;
  warnings: string[];
  errorMessage?: string;
}

export interface ConversionJobInputItem {
  trackId?: string;
  sourcePath: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number | null;
  sourceAudioSpec?: SourceAudioSpec;
}

export interface ConversionJobRecord {
  id: string;
  batchId: string;
  trackId: string | null;
  title: string;
  artist: string;
  sourcePath: string;
  outputPath: string | null;
  targetFormat: ConvertTargetFormat;
  encoderLabel: string;
  pipelineMode: 'direct' | 'piped';
  commandPreview: string;
  status: ConversionJobStatus;
  progressMode: ConversionProgressMode;
  progressPercent: number;
  speedLabel: string | null;
  outputSizeBytes: number | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  warnings?: string[];
  verification?: OutputVerificationReport | null;
  terminationReason?: ProcessTerminationReason | null;
}

export interface ConversionQueueSnapshot {
  jobs: ConversionJobRecord[];
  activeCount: number;
  queuedCount: number;
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  concurrency: number;
  effectiveConcurrency: number;
  resourceMode: ResourceMode;
  playbackPriorityActive: boolean;
  isPaused: boolean;
  isProcessing: boolean;
}

export interface ConversionProgressEvent {
  jobId: string;
  status: ConversionJobStatus;
  progressMode: ConversionProgressMode;
  progressPercent: number;
  speedLabel: string | null;
  outputPath: string | null;
  outputSizeBytes: number | null;
  errorMessage: string | null;
  verificationStatus?: OutputVerificationStatus | null;
}

export interface ConversionPipelineStep {
  codecId: CodecId;
  executableName: string;
  args: string[];
}

export interface ConversionCommandPlan {
  pipelineMode: 'direct' | 'piped';
  encoderLabel: string;
  targetExtension: string;
  steps: ConversionPipelineStep[];
  commandPreview: string;
  requiredCodecs: CodecId[];
  notes: string[];
  warnings: string[];
  fallbackFromNative?: boolean;
  requiresTempWavInput?: boolean;
  metadataHandlingNote?: string;
  artworkHandlingNote?: string;
}

export type LosslessVerificationStatus =
  | 'lossless-codec'
  | 'lossy-compressed'
  | 'uncompressed-pcm'
  | 'wavpack-hybrid'
  | 'wavpack-lossy'
  | 'unknown';

export type FfprobeExecutionStatus =
  | 'ok'
  | 'missing'
  | 'incompatible'
  | 'missing-dependency'
  | 'unverified'
  | 'pending-desktop-verification'
  | 'timeout'
  | 'execution-failed'
  | 'invalid-json'
  | 'audio-stream-not-found';

export type DecoderStrategyKind =
  | 'supported-playback-engine'
  | 'alac-wasm'
  | 'native-decoder-candidate'
  | 'ffmpeg-fallback-candidate'
  | 'unsupported';

export type WavPackModeKind =
  | 'lossless'
  | 'hybrid-with-correction'
  | 'hybrid-without-correction'
  | 'lossy'
  | 'unknown';

export interface AudioAnalysisReport {
  analyzedAt: string;
  sourcePath: string;
  trackId: string | null;
  fileName: string;
  fileExtension: string;
  fileSizeBytes: number;
  analyzerBackend: 'ffprobe' | 'music-metadata-fallback';
  ffprobeStatus: FfprobeExecutionStatus;
  ffprobeErrorDetail: string | null;
  container: string;
  codec: string;
  codecLongName: string;
  codecInferredFromExtension: boolean;
  sampleFormat: SourceSampleFormat;
  rawSampleFmt: string | null;
  losslessStatus: LosslessVerificationStatus;
  losslessSummary: string;
  wavpackMode: WavPackModeKind | null;
  fileIntegrityStatus: 'header-probed' | 'metadata-only' | 'unverified';
  sourceAuthenticityNote: string;
  playbackOutputNote: string;
  durationSec: number | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
  channelLayout: string | null;
  bitrateBps: number | null;
  compressionRatio: number | null;
  estimatedPcmBitrateBps: number | null;
  estimatedMetrics: {
    bitrateEstimated: boolean;
    pcmBitrateEstimated: boolean;
    compressionRatioEstimated: boolean;
  };
  decoderStrategy: DecoderStrategyKind;
  decoderStrategyLabel: string;
  pendingPlaybackIntegration: boolean;
  replayGain: {
    trackGainDb: number | null;
    albumGainDb: number | null;
    trackPeak: number | null;
    albumPeak: number | null;
  };
  r128TrackGainDb: number | null;
  loudness: {
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    loudnessRangeLu: number | null;
    measured: boolean;
  };
  tags: Record<string, string>;
  warnings: string[];
}

export interface CodecImportPackResult {
  canceled: boolean;
  importedCount: number;
  skippedCount: number;
  importedCodecs: CodecId[];
  importedSupportingDlls?: string[];
  importedLicenseFiles?: string[];
  errors: string[];
  inventory: CodecInventorySnapshot;
}

export interface CodecImportBinaryResult {
  canceled: boolean;
  codecId: CodecId;
  imported: boolean;
  entry: CodecRuntimeEntry | null;
  error?: string;
  inventory: CodecInventorySnapshot;
}

export interface CodecUpdateCheckResult {
  checkedAt: string;
  mode: 'offline-manifest' | 'remote-manifest';
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  missingRecommendedCodecs: CodecId[];
  message: string;
  releaseNotes: string[];
}

export interface TranscodingProfile {
  id: string;
  name: string;
  description: string;
  targetFormat: 'opus' | 'aac' | 'mp3' | 'flac';
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  /** null = preserve source channel layout (never force stereo downmix) */
  channels: number | null;
  containerMime: string;
  estimatedMbPerMinute: number;
  useCase: 'mobile-cellular' | 'wifi-balanced' | 'lan-lossless' | 'universal-compat';
}

export interface StreamingTranscodePlan {
  profile: TranscodingProfile;
  available: boolean;
  requiredCodec: CodecId;
  args: string[];
  commandPreview: string;
  reasonIfUnavailable?: string;
  notes?: string[];
}
