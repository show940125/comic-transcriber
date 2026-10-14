import type { Diagnostic, EngineRequest } from './types';
import { imageBase64 } from './binary';
import {extensionCall,detached,contextAlive} from './extension-context';
export async function engine(request: EngineRequest, progress?: (d: Diagnostic) => void, signal?: AbortSignal): Promise<any> {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  const id = crypto.randomUUID();
  const listener = (message: any) => { if (message.channel === 'progress' && message.id === id) progress?.(message.diagnostic); };
  await extensionCall(()=>chrome.runtime.onMessage.addListener(listener));
  const abort = () => { if(contextAlive())detached(()=>chrome.runtime.sendMessage({ channel: 'cancel', id })); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    // Chrome messaging uses JSON, so binary input is converted before the boundary.
    const encoded = 'image' in request ? { ...request, image: imageBase64(new Uint8Array(await request.image.arrayBuffer())), mime: request.image.type } : request;
    signal?.throwIfAborted();
    const result = await extensionCall(()=>chrome.runtime.sendMessage({ channel: 'engine', id, request: encoded }));
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    if (!result?.ok) throw new Error(result?.error || '推論頁面未回應');
    return result.result;
  } finally { if(contextAlive())detached(()=>chrome.runtime.onMessage.removeListener(listener));signal?.removeEventListener('abort', abort); }
}
