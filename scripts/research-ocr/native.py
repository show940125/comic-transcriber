"""Single-process native CPU control, no translation or remote inference."""
import argparse, ctypes, hashlib, json, os, sys, time
from pathlib import Path
import numpy as np
import onnxruntime as ort
from prepare import ROOT, OUT, save, sha

def peak_memory():
    class Counters(ctypes.Structure):
        _fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong)]+[(n,ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
    c=Counters();c.cb=ctypes.sizeof(c)
    ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(-1),ctypes.byref(c),c.cb)
    return {'peakWorkingSetBytes':c.PeakWorkingSetSize,'workingSetBytes':c.WorkingSetSize,'privateCommitBytes':c.PagefileUsage,'scope':'whole native runner process; counters are not additive'}

class Manga:
    def __init__(self,variant,threads=1):
        self.variant=variant
        options=ort.SessionOptions();options.intra_op_num_threads=threads;options.inter_op_num_threads=1;options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
        paths=[ROOT/'.cache/models/manga-ocr/encoder_model.onnx',ROOT/'.cache/models/manga-ocr/decoder_model.onnx']
        if variant=='int8':paths=[OUT/'models/int8/encoder_model_int8.onnx',OUT/'models/int8/decoder_model_int8.onnx']
        if variant=='kv':paths=[paths[0],OUT/'models/kv/decoder_kv.onnx',OUT/'models/kv/cross_kv.onnx']
        self.sessions=[ort.InferenceSession(str(p),sess_options=options,providers=['CPUExecutionProvider']) for p in paths]
        self.contract=[{'file':str(p),'sha256':sha(p),'inputs':[{'name':i.name,'shape':i.shape,'type':i.type} for i in s.get_inputs()],'outputs':[{'name':i.name,'shape':i.shape,'type':i.type} for i in s.get_outputs()]} for p,s in zip(paths,self.sessions)]
        self.vocab=(ROOT/'.cache/models/manga-ocr/vocab.txt').read_text('utf-8').splitlines()
        if variant=='int8':
            other=(OUT/'models/int8/vocab.txt').read_text('utf-8').splitlines()
            if other!=self.vocab:raise ValueError('INT8 vocabulary does not match baseline')

    def infer(self,row):
        started=time.perf_counter();tokens=[2];steps=[]
        if row['skipBlank']:return {'id':row['id'],'source':'','tokens':tokens,'ended':True,'skippedBlank':True,'ms':(time.perf_counter()-started)*1000}
        tensor=np.fromfile(OUT/row['tensor'],dtype='<f4').reshape(1,3,224,224)
        encoder,decoder=self.sessions[:2]
        hidden=encoder.run(None,{encoder.get_inputs()[0].name:tensor})[0]
        cross=past=None
        if self.variant=='kv':
            cross=self.sessions[2].run(None,{'encoder_hidden_states':hidden})[0]
            past=np.zeros((4,1,12,1,64),dtype=np.float32)
        ended=False
        for _ in range(64):
            if self.variant=='kv':
                output=decoder.run(None,{'input_ids':np.array([[tokens[-1]]],dtype=np.int64),'beam_idx':np.array([0],dtype=np.int64),'past_key_values':past,'cross_key_values':cross})
                logits=output[0];past=output[1]
            else:
                feeds={i.name:hidden if ('encoder' in i.name or 'hidden' in i.name) else np.array([tokens],dtype=np.int64) for i in decoder.get_inputs()}
                logits=decoder.run(None,feeds)[0]
            scores=logits.reshape(-1,logits.shape[-1])[-1]
            token=int(np.argmax(scores));steps.append({'token':token,'maxLogit':float(scores[token])})
            if token==3:ended=True;break
            tokens.append(token)
        text=''.join(self.vocab[t] for t in tokens[1:] if t>=5).replace('##','').replace('[UNK]','')
        text=''.join(text.split())
        return {'id':row['id'],'source':text,'tokens':tokens,'steps':steps,'ended':ended,'truncated':not ended,'ms':(time.perf_counter()-started)*1000}

def main():
    p=argparse.ArgumentParser();p.add_argument('--variant',choices=['baseline','int8','kv'],required=True);p.add_argument('--mode',choices=['smoke','all'],default='all');args=p.parse_args()
    data=json.loads((OUT/'dataset.json').read_text('utf-8'));refs=json.loads((OUT/'references.json').read_text('utf-8'));assert refs['status']=='frozen-before-inference'
    started=time.perf_counter();engine=Manga(args.variant);init=(time.perf_counter()-started)*1000
    rows=data['records'] if args.mode=='all' else [r for r in data['records'] if r['id']==data['sample'][0]]
    result={'variant':args.variant,'runnerSha256':sha(__file__),'runtime':ort.__version__,'backend':'onnxruntime CPUExecutionProvider, intra=1/inter=1','status':'running','initMs':init,'modelContract':engine.contract,'datasetSha256':sha(OUT/'dataset.json'),'referencesSha256':sha(OUT/'references.json'),'results':[],'performance':[]}
    name=f'results/native-{args.variant}-{args.mode}.json'
    try:
        for i,row in enumerate(rows):
            result['results'].append(engine.infer(row))
            if i%20==0 or i==len(rows)-1:
                result['memory']=peak_memory();save(name,result);print(f'{args.variant}: {i+1}/{len(rows)}',flush=True)
        if args.mode=='all':
            sample=[next(r for r in rows if r['id']==rid) for rid in data['sample']]
            for run in range(3):
                output=[engine.infer(r) for r in sample]
                result['performance'].append({'run':run+1,'warm':True,'totalMs':sum(r['ms'] for r in output),'rows':[{k:r[k] for k in ['id','ms','source']} for r in output]})
                save(name,result);print(f'{args.variant}: warm {run+1}',flush=True)
        result['status']='complete';result['totalSeconds']=time.perf_counter()-started;result['memory']=peak_memory();save(name,result)
    except Exception as error:
        result.update(status='failed',error=repr(error),memory=peak_memory());save(name,result);raise

if __name__=='__main__':main()
