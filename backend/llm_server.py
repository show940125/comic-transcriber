import argparse,json
from http.server import BaseHTTPRequestHandler,HTTPServer
from native_llm import complete

class Handler(BaseHTTPRequestHandler):
    def permitted(self):
        origin=self.headers.get('Origin','')
        return not origin or origin.startswith('chrome-extension://')
    def respond(self,status,data=None):
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        if self.permitted() and self.headers.get('Origin'):self.send_header('Access-Control-Allow-Origin',self.headers['Origin']);self.send_header('Vary','Origin')
        self.send_header('Access-Control-Allow-Headers','Content-Type');self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS');self.end_headers()
        if data is not None:self.wfile.write(json.dumps(data,ensure_ascii=False).encode('utf-8'))
    def do_OPTIONS(self):self.respond(204 if self.permitted() else 403)
    def do_GET(self):
        if self.path=='/health':self.respond(200,{'ok':True,'backend':'llama.cpp-cpu','version':'0.1.0'})
        elif self.path=='/v1/models':self.respond(200,{'object':'list','data':[{'id':'qwen3.5-2b','object':'model'},{'id':'qwen3.5-0.8b','object':'model'}]})
        else:self.respond(404,{'error':'Unknown endpoint'})
    def do_POST(self):
        if not self.permitted():self.respond(403,{'error':'Origin refused'});return
        if self.path!='/v1/chat/completions':self.respond(404,{'error':'Unknown endpoint'});return
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=2*1024*1024:raise ValueError('Request too large')
            data=json.loads(self.rfile.read(size))
            if data.get('stream'):raise ValueError('Streaming is not supported')
            text,ms=complete(data['messages'],data.get('model','qwen3.5-2b'),data.get('max_tokens',800))
            self.respond(200,{'object':'chat.completion','choices':[{'index':0,'message':{'role':'assistant','content':text},'finish_reason':'stop'}],'backend':'llama.cpp-cpu','ms':ms})
        except Exception as error:self.respond(400,{'error':str(error)})

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8767);args=parser.parse_args()
    print(f'CPU translation: http://127.0.0.1:{args.port}/v1, models=qwen3.5-2b / qwen3.5-0.8b. Foreground; Ctrl+C to stop.',flush=True)
    HTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
