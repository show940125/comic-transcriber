"""Opt-in, CPU-only llama.cpp companion. CLI children exit naturally after one turn."""
import json,pathlib,re,subprocess,tempfile,time
ROOT=pathlib.Path(__file__).resolve().parents[1]

def complete(messages,model='qwen3.5-2b',max_tokens=800):
    lock=json.loads((ROOT/'artifacts/native-llm-lock.json').read_text(encoding='utf-8'))
    size=model.lower().replace('qwen3.5-','')
    spec=next((m for m in lock['models'] if m['id']==size),None)
    if spec is None:raise ValueError('Model must be qwen3.5-2b or qwen3.5-0.8b')
    tag=lock['binary']['tag']
    if not re.fullmatch(r'b\d+',tag):raise ValueError('Invalid binary tag')
    binaries=list((ROOT/'.cache/native'/tag).rglob('llama-completion.exe'))
    weights=ROOT/'.cache/native/models'/spec['name']
    if not binaries or not weights.is_file():raise ValueError('Run node scripts/prepare-native.mjs first')
    if not isinstance(messages,list) or len(messages)>8 or any(not isinstance(m.get('content'),str) for m in messages):raise ValueError('Invalid messages')
    system='\n'.join(m['content'] for m in messages if m.get('role')=='system')
    user='\n'.join(m['content'] for m in messages if m.get('role')=='user')
    if len(system)+len(user)>16000:raise ValueError('Prompt too large')
    dialogue=json.loads(user)['dialogue']
    if not isinstance(dialogue,list) or not 1<=len(dialogue)<=20 or any(not isinstance(r.get('id'),str) for r in dialogue):raise ValueError('Invalid dialogue')
    schema={'type':'array','prefixItems':[{'type':'object','properties':{'id':{'const':r['id']},'text':{'type':'string','minLength':1,'maxLength':max(24,min(256,len(r.get('text',''))*3+32))}},'required':['id','text'],'additionalProperties':False} for r in dialogue],'minItems':len(dialogue),'maxItems':len(dialogue)}
    parent=ROOT/'.cache/native/prompts';parent.mkdir(parents=True,exist_ok=True)
    started=time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='request-',dir=parent) as folder:
        directory=pathlib.Path(folder).resolve()
        if not directory.is_relative_to(parent.resolve()):raise ValueError('Temporary path escaped workspace')
        formatted=f'<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
        (directory/'prompt.txt').write_text(formatted,encoding='utf-8');(directory/'schema.json').write_text(json.dumps(schema,ensure_ascii=False),encoding='utf-8')
        args=[str(binaries[0]),'--model',str(weights),'--ctx-size','4096','--threads','6','--gpu-layers','0','--predict',str(min(1000,max(64,int(max_tokens)))),'--no-conversation','--simple-io','--no-display-prompt','--no-warmup','--no-perf','--temp','0','--file',str(directory/'prompt.txt'),'--json-schema-file',str(directory/'schema.json')]
        process=subprocess.run(args,cwd=ROOT,capture_output=True,stdin=subprocess.DEVNULL)
        raw=process.stdout.decode('utf-8',errors='replace')
        if process.returncode!=0:raise RuntimeError(f'llama.cpp exit {process.returncode}: '+process.stderr.decode('utf-8',errors='replace')[-1600:])
    decoder=json.JSONDecoder();wanted=[r['id'] for r in dialogue]
    for match in re.finditer(r'\[',raw):
        try:data,_=decoder.raw_decode(raw[match.start():])
        except json.JSONDecodeError:continue
        if isinstance(data,list) and len(data)==len(wanted) and all(isinstance(r,dict) and isinstance(r.get('text'),str) and r['text'].strip() for r in data) and [r.get('id') for r in data]==wanted:
            return json.dumps(data,ensure_ascii=False),(time.perf_counter()-started)*1000
    raise RuntimeError('Native model did not return complete ordered translation JSON: '+raw[-1200:])
