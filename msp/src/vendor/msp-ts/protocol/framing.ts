/**
 * 4 字节大端长度前缀的分帧（传输层约定，与 msp-py TCPTransport 一致）。
 */

/** 4 字节大端长度前缀的流式解码器。push 任意分块，弹出完整帧。 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 64 * 1024 * 1024) {
        throw new Error(`帧长度超限（${len} 字节），流已损坏`);
      }
      if (this.buf.length < 4 + len) break;
      frames.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }
}

export function frameMessage(data: Buffer | Uint8Array): Buffer {
  const body = Buffer.from(data);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// ----------------------------------------------------------------------
