/// <reference types="vite/client" />
/// <reference types="@iwsdk/vite-plugin-dev/client" />

declare module '@qw/client' {
  export interface StreamStats {
    width: number;
    height: number;
    fps: number;
    mbps: number;
    codec: string;
    decoder: string;
    powerEfficient: boolean;
    framesDropped: number;
    jitterMs: number;
    decodeMs: number;
    jitterBufferMs: number;
    rttMs: number | string;
  }
  export function connectViewer(opts: {
    name: string;
    onStream: (stream: MediaStream) => void;
    onState?: (state: string) => void;
    onMessage?: (msg: { type: string; [key: string]: unknown }) => void;
  }): {
    send(msg: unknown): void;
    sendBinary(data: ArrayBuffer | ArrayBufferView): boolean;
    stats(): Promise<StreamStats | null>;
  };
}
