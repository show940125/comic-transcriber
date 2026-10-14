export interface GpuCapability {
  available: boolean; f16: boolean;
  info: { vendor: string; architecture: string; device: string; description: string } | null;
  limits: { maxBufferSize: number; maxStorageBufferBindingSize: number } | null;
  reason?: string;
}
const unavailable = (reason: string): GpuCapability => ({ available: false, f16: false, info: null, limits: null, reason });

// Probe only when a GPU-backed operation needs it; null results are cached too.
export function createGpuProbe(getGpu: () => GPU | undefined) {
  let pending: Promise<GpuCapability> | undefined;
  return (refresh = false): Promise<GpuCapability> => {
    if (refresh) pending = undefined;
    return pending ??= (async () => {
      const gpu = getGpu();
      if (!gpu) return unavailable('此環境未提供 WebGPU，OCR 可使用 WASM');
      try {
        // Chrome on Windows ignores powerPreference and emits a warning for it.
        const adapter = await gpu.requestAdapter();
        if (!adapter) return unavailable('未取得 WebGPU adapter，OCR 可使用 WASM');
        return { available: true, f16: adapter.features.has('shader-f16'),
          info: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description },
          limits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } };
      } catch (error) { return unavailable(`WebGPU 檢查失敗：${error instanceof Error ? error.message : String(error)}`); }
    })();
  };
}
