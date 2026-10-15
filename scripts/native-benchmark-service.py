"""Loopback-only benchmark harness; production service retains its origin rules."""
import sys,argparse,json
from pathlib import Path
from http.server import HTTPServer
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'backend'))
import server as backend
from vision import Vision
parser=argparse.ArgumentParser();parser.add_argument('--origin',required=True);parser.add_argument('--port',type=int,default=9766);parser.add_argument('--threads',type=int,choices=[1,2,4],default=4);args=parser.parse_args()
if not args.origin.startswith('http://127.0.0.1:'):raise ValueError('benchmark origin must be loopback')
backend.vision=Vision(args.threads)
class Handler(backend.Handler):
    def allowed_origin(self):return self.headers.get('Origin','') in ('',args.origin)
    def do_POST(self):
        if self.path=='/finish' and self.allowed_origin():
            self.respond(200);self.wfile.write(b'{"ok":true}');self.server.done=True;return
        return super().do_POST()
server=HTTPServer(('127.0.0.1',args.port),Handler);server.done=False
print(json.dumps({'url':f'http://127.0.0.1:{args.port}','threads':args.threads,'origin':args.origin}),flush=True)
try:
    while not server.done:server.handle_request()
finally:server.server_close()
