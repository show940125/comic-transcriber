import pathlib,sys,threading,json,urllib.request,urllib.error,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from llm_server import Handler
from http.server import HTTPServer
class NativeHTTPTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=HTTPServer(('127.0.0.1',0),Handler);cls.url=f'http://127.0.0.1:{cls.server.server_port}';cls.thread=threading.Thread(target=cls.server.serve_forever);cls.thread.start()
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def test_models(self):self.assertEqual(len(json.load(urllib.request.urlopen(self.url+'/v1/models'))['data']),2)
    def test_public_origin_refused(self):
        req=urllib.request.Request(self.url+'/v1/chat/completions',data=b'{}',headers={'Origin':'https://evil.test'})
        with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
        self.assertEqual(error.exception.code,403);error.exception.close()
    def test_protocol_with_fixture(self):
        with patch('llm_server.complete',return_value=('[{"id":"a","text":"你好"}]',123)):
            req=urllib.request.Request(self.url+'/v1/chat/completions',data=json.dumps({'messages':[{'role':'user','content':'test'}],'model':'qwen3.5-2b'}).encode(),headers={'Origin':'chrome-extension://fixture','Content-Type':'application/json'})
            with urllib.request.urlopen(req) as response:
                self.assertEqual(response.headers['Access-Control-Allow-Origin'],'chrome-extension://fixture');data=json.load(response);self.assertEqual(data['backend'],'llama.cpp-cpu');self.assertEqual(json.loads(data['choices'][0]['message']['content'])[0]['id'],'a')
if __name__=='__main__':unittest.main()
