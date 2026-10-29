"""User-authorized bounded CPU throughput matrix, separate from solo timing."""
import concurrent.futures,ctypes,json,multiprocessing,os,statistics,time
from prepare import OUT,save,sha
from native import Manga,peak_memory
from metrics import parity

ENGINE=None
def initialize(variant,threads,barrier):
    global ENGINE
    ENGINE=Manga(variant,threads)
    barrier.wait()

def recognize(row):
    cpu=time.process_time();result=ENGINE.infer(row)
    result['cpuSeconds']=time.process_time()-cpu;result['pid']=os.getpid();result['memory']=peak_memory()
    return result

def free_memory():
    class Status(ctypes.Structure):
        _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(k,ctypes.c_ulonglong) for k in ['totalPhys','availPhys','totalPage','availPage','totalVirtual','availVirtual','availExtended']]
    value=Status();value.length=ctypes.sizeof(value);ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value));return value.availPhys

def main():
    os.environ['OMP_NUM_THREADS']='1';os.environ['OPENBLAS_NUM_THREADS']='1'
    dataset=json.loads((OUT/'dataset.json').read_text('utf-8'))
    samples=[next(r for r in dataset['records'] if r['id']==rid) for rid in dataset['sample']]
    report={'status':'running','logicalProcessors':os.cpu_count(),'datasetSha256':sha(OUT/'dataset.json'),'scope':'50 fixed real-comic crops; CPU throughput experiment, not mixed with solo controls','configurations':[]}
    context=multiprocessing.get_context('spawn')
    for variant in ['baseline','int8','kv']:
        control=json.loads((OUT/f'results/native-{variant}-all.json').read_text('utf-8'))
        reference=[r for r in control['results'] if r['id'] in dataset['sample']]
        for workers,threads in [(1,4),(2,4)]:
            item={'variant':variant,'workers':workers,'intraThreadsPerWorker':threads,'interThreads':1,'availableMemoryBeforeBytes':free_memory(),'runs':[]}
            if workers==2 and (os.cpu_count()<8 or item['availableMemoryBeforeBytes']<3*1024**3):
                item.update(status='skipped-resource-limit',reason='Need >=8 logical processors and >=3 GiB available before two-worker run');report['configurations'].append(item);save('results/throughput.json',report);continue
            print(f'throughput {variant}: workers={workers}, threads={threads}',flush=True)
            barrier=context.Barrier(workers);began=time.perf_counter()
            with concurrent.futures.ProcessPoolExecutor(max_workers=workers,mp_context=context,initializer=initialize,initargs=(variant,threads,barrier)) as pool:
                # Barrier makes every model session ready before inference timing.
                list(pool.map(recognize,samples[:max(2,workers)],chunksize=1));item['startupAndWarmupMs']=(time.perf_counter()-began)*1000
                for run in range(3):
                    start=time.perf_counter();output=list(pool.map(recognize,samples,chunksize=1));elapsed=time.perf_counter()-start
                    item['runs'].append({'run':run+1,'wallSeconds':elapsed,'cropsPerSecond':len(samples)/elapsed,'inferenceProcessCpuPercentOfMachine':100*sum(r['cpuSeconds'] for r in output)/(elapsed*os.cpu_count()),'tokenParity':parity(reference,output),'workerMemory':{str(r['pid']):r['memory'] for r in output},'results':output})
                    save('results/throughput.json',{**report,'activeConfiguration':item});print(f'  run {run+1}: {elapsed:.3f}s; pids={sorted({r["pid"] for r in output})}',flush=True)
            item.update(status='complete',median50Seconds=statistics.median(r['wallSeconds'] for r in item['runs']))
            report['configurations'].append(item);save('results/throughput.json',report)
    report.update(status='complete');save('results/throughput.json',report)

if __name__=='__main__':main()
