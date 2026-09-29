import AVFoundation
import CoreMedia
import CoreVideo

// Writes a tiny H.264 MP4: WxH, `frames` frames at 24 fps, optionally with a silent AAC track.
let args = CommandLine.arguments
let out = URL(fileURLWithPath: args[1])
let width = Int(args[2])!, height = Int(args[3])!, frames = Int(args[4])!, withAudio = args[5] == "1"
try? FileManager.default.removeItem(at: out)
let writer = try! AVAssetWriter(outputURL: out, fileType: .mp4)
writer.shouldOptimizeForNetworkUse = true
let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 20_000, AVVideoMaxKeyFrameIntervalKey: 24],
])
video.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width,
  kCVPixelBufferHeightKey as String: height,
])
writer.add(video)
var audio: AVAssetWriterInput? = nil
if withAudio {
  let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 24000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 16000,
  ])
  a.expectsMediaDataInRealTime = false
  writer.add(a)
  audio = a
}
writer.startWriting()
writer.startSession(atSourceTime: .zero)
for i in 0..<frames {
  while !video.isReadyForMoreMediaData { usleep(1000) }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  CVPixelBufferLockBaseAddress(pb!, [])
  let base = CVPixelBufferGetBaseAddress(pb!)!.assumingMemoryBound(to: UInt8.self)
  let stride = CVPixelBufferGetBytesPerRow(pb!)
  for y in 0..<height { for x in 0..<width {
    let p = base + y * stride + x * 4
    p[0] = UInt8((x * 255) / max(1, width - 1)); p[1] = UInt8((y * 255) / max(1, height - 1))
    p[2] = UInt8((i * 255) / max(1, frames - 1)); p[3] = 255
  } }
  CVPixelBufferUnlockBaseAddress(pb!, [])
  adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 24))
}
video.markAsFinished()
if let a = audio {
  // Silence, as 16-bit mono PCM, the clip's length.
  let rate = 24000.0
  let total = Int(rate * Double(frames) / 24.0)
  var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked, mBytesPerPacket: 2,
    mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
  var fmt: CMAudioFormatDescription?
  CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0,
    magicCookie: nil, extensions: nil, formatDescriptionOut: &fmt)
  var done = 0
  while done < total {
    while !a.isReadyForMoreMediaData { usleep(1000) }
    let n = min(1024, total - done)
    var block: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: n * 2, blockAllocator: nil,
      customBlockSource: nil, offsetToData: 0, dataLength: n * 2, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
    CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: n * 2)
    var sb: CMSampleBuffer?
    CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: fmt!,
      sampleCount: n, presentationTimeStamp: CMTime(value: CMTimeValue(done), timescale: CMTimeScale(rate)),
      packetDescriptions: nil, sampleBufferOut: &sb)
    a.append(sb!)
    done += n
  }
  a.markAsFinished()
}
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status != .completed { print("failed", writer.error as Any); exit(1) }
