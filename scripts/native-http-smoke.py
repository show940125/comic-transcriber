import json,pathlib,sys,threading,urllib.request
from http.server import HTTPServer
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from llm_server import Handler

server=HTTPServer(('127.0.0.1',0),Handler)
thread=threading.Thread(target=server.serve_forever);thread.start()
result={'kind':'actual CPU model over localhost HTTP; original test dialogue','fixture':False}
try:
    messages=[{'role':'system','content':'Translate Japanese dialogue into Taiwan Traditional Chinese. Output JSON array only.'},{'role':'user','content':json.dumps({'dialogue':[{'id':'smoke-1','text':'一緒に帰ろう。'}]},ensure_ascii=False)}]
    request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/v1/chat/completions',data=json.dumps({'model':'qwen3.5-2b','messages':messages,'max_tokens':160}).encode(),headers={'Content-Type':'application/json','Origin':'chrome-extension://smoke-test'})
    with urllib.request.urlopen(request,timeout=180) as response:
        result['httpStatus']=response.status;data=json.load(response)
    rows=json.loads(data['choices'][0]['message']['content'])
    assert len(rows)==1 and rows[0]['id']=='smoke-1' and rows[0]['text']
    result.update(status='passed',backend=data['backend'],ms=data['ms'],rows=rows)
finally:
    server.shutdown();server.server_close();thread.join()
    (ROOT/'artifacts/native-http-smoke.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))
