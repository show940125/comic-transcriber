"""Read FlatBuffer metadata only; no DLL inspection or inference."""
import json,struct
from pathlib import Path
from prepare import OUT,save,sha

class Model:
    def __init__(self,path):
        self.path=Path(path);self.b=self.path.read_bytes()
        if self.b[4:8]!=b'TFL3':raise ValueError('Not a TFLite FlatBuffer')
    def u(self,p):return struct.unpack_from('<I',self.b,p)[0]
    def i(self,p):return struct.unpack_from('<i',self.b,p)[0]
    def field(self,t,n):
        v=t-self.i(t);s=4+2*n
        if s>=struct.unpack_from('<H',self.b,v)[0]:return None
        o=struct.unpack_from('<H',self.b,v+s)[0];return t+o if o else None
    def indirect(self,p):return p+self.u(p)
    def vector(self,p,width=4):
        if p is None:return []
        v=self.indirect(p);return [v+4+width*j for j in range(self.u(v))]
    def string(self,p):
        if p is None:return None
        s=self.indirect(p);return self.b[s+4:s+4+self.u(s)].decode('utf-8','replace')
    def tensor(self,t):
        q=self.field(t,4);q=self.indirect(q) if q else None;typ=self.field(t,1)
        return {'name':self.string(self.field(t,3)),'shape':[self.i(x) for x in self.vector(self.field(t,0))],
                'shapeSignature':[self.i(x) for x in self.vector(self.field(t,7))],'type':self.b[typ] if typ else 0,
                'scales':[struct.unpack_from('<f',self.b,x)[0] for x in self.vector(self.field(q,2))] if q else [],
                'zeroPoints':[struct.unpack_from('<q',self.b,x)[0] for x in self.vector(self.field(q,3),8)] if q else []}
    def describe(self):
        root=self.u(0);operators=[]
        for p in self.vector(self.field(root,1)):
            t=self.indirect(p);custom=self.string(self.field(t,1));f=self.field(t,3);old=self.field(t,0)
            operators.append({'custom':custom,'builtin':self.i(f) if f else self.b[old] if old else 0})
        subgraphs=[]
        for p in self.vector(self.field(root,2)):
            t=self.indirect(p);tensors=self.vector(self.field(t,0))
            subgraphs.append({key:[self.tensor(self.indirect(tensors[self.i(x)])) for x in self.vector(self.field(t,n))] for n,key in [(1,'inputs'),(2,'outputs')]})
        return {'file':str(self.path),'sha256':sha(self.path),'bytes':len(self.b),'operators':operators,'subgraphs':subgraphs}

if __name__=='__main__':
    base=Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4'
    values=[Model(p).describe() for p in base.rglob('*.tflite')]
    save('tflite-inspection.json',{'schemaSource':'https://github.com/tensorflow/tensorflow/blob/master/tensorflow/compiler/mlir/lite/schema/schema.fbs','models':values})
    print(json.dumps({'models':len(values),'customOperators':[(Path(r['file']).name,[o['custom'] for o in r['operators'] if o['custom']]) for r in values if any(o['custom'] for o in r['operators'])]}))
