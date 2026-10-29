"""Per-process Windows memory counters; peaks across processes are not summed."""
import ctypes,json,sys
class Counters(ctypes.Structure):
    _fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong)]+[(n,ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
kernel=ctypes.windll.kernel32;kernel.OpenProcess.restype=ctypes.c_void_p
def own_memory():
    c=Counters();c.cb=ctypes.sizeof(c)
    if not ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(-1),ctypes.byref(c),c.cb):raise ctypes.WinError()
    return {'peakWorkingSetBytes':c.PeakWorkingSetSize,'workingSetBytes':c.WorkingSetSize,'privateCommitBytes':c.PagefileUsage,'scope':'whole native runner process; counters are not additive'}

if __name__=='__main__':
    rows=[]
    for item in json.loads(sys.argv[1]):
        handle=kernel.OpenProcess(0x410,False,item['id']);c=Counters();c.cb=ctypes.sizeof(c)
        if handle:
            ok=ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(handle),ctypes.byref(c),c.cb)
            kernel.CloseHandle(ctypes.c_void_p(handle))
            if ok:rows.append({**item,'peakWorkingSetBytes':c.PeakWorkingSetSize,'workingSetBytes':c.WorkingSetSize,'privateCommitBytes':c.PagefileUsage})
    print(json.dumps({'scope':'individual browser processes at completion; per-process lifetime peaks, not simultaneous aggregate peak','processes':rows}))
