export type Stage = 'queued' | 'loading' | 'detecting' | 'review' | 'ocr' | 'translating' | 'rendering' | 'complete' | 'error' | 'cancelled';
export interface Rect { x:number; y:number; width:number; height:number }
export interface Region {
  id: string; x: number; y: number; width: number; height: number; order: number;
  source: string; translation: string; score: number; warnings: string[];
  kind: 'bubble' | 'free'; render: 'auto' | 'overlay' | 'fill' | 'rectangle';
  needsReview?: boolean;
  ocrDone?:boolean;
  ocrBox?: { x: number; y: number; width: number; height: number };
  bubbleBox?: Rect;
  textDirection?: 'auto' | 'horizontal' | 'vertical';
  fontScale?: number;
}
export interface PageData {
  schema: 1; hash: string; width: number; height: number; regions: Region[];
  title: string; chapter: string; glossary: string; summary: string; modelKey: string;
}
export interface Diagnostic {
  stage: Stage; message: string; backend?: string; model?: string; ms?: number;
  httpStatus?:number;regionId?:string;attempt?:number;cause?:'http'|'network'|'cancel';
  jobId?:string;pageIndex?:number;
}
export interface Settings {
  backend: 'webllm' | 'local' | 'chrome' | 'google-web'; model: '2b' | '0.8b'; localFallback: boolean;
  endpoint: string; localModel: string; ocrEndpoint: string; localOcr: boolean; ocrProvider: 'auto' | 'wasm';
  auto: boolean; glossary: string; title: string; chapter: string; priorSummary: string;
  pageConcurrency: 1 | 2;
}
export const defaults: Settings = {
  backend: 'google-web', model: '2b', localFallback: false, endpoint: 'http://127.0.0.1:8080/v1',
  localModel: '', ocrEndpoint: 'http://127.0.0.1:8766', localOcr: false, ocrProvider: 'wasm',
  auto: false, glossary: '', title: '', chapter: '', priorSummary: '',
  pageConcurrency: 2,
};
export type EngineRequest =
  | { op: 'detect'; image: Blob; width: number; height: number }
  | { op: 'ocr'; image: Blob; regions: Region[]; provider?: 'auto' | 'wasm' }
  | { op:'local-ocr'; image:Blob; regions:Region[]; endpoint:string }
  | { op: 'translate'; regions: Region[]; settings: Settings; modelId: string }
  | { op: 'prefetch'; modelId: string }
  | { op: 'release-llm' }
  | { op: 'probe'; refresh?: boolean };
export interface WorkerRequest { id: string; request: EngineRequest }
