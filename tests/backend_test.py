import pathlib,sys,threading,urllib.request,urllib.error,json,base64,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from server import Handler
from http.server import HTTPServer

class BackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=HTTPServer(('127.0.0.1',0),Handler);cls.port=cls.server.server_port
        cls.thread=threading.Thread(target=cls.server.serve_forever);cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def test_health(self):
        result=json.load(urllib.request.urlopen(f'http://127.0.0.1:{self.port}/health'));self.assertTrue(result['ok'])
    def test_web_origin_rejected(self):
        request=urllib.request.Request(f'http://127.0.0.1:{self.port}/ocr',data=b'{}',headers={'Origin':'https://evil.test'})
        with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request)
        self.assertEqual(error.exception.code,403)
    def test_actual_ocr_and_cors(self):
        manifest=json.loads((ROOT/'artifacts/corpus/manifest.json').read_text(encoding='utf-8'));page=manifest['pages'][0]
        body={'image':base64.b64encode((ROOT/'artifacts/corpus'/page['file']).read_bytes()).decode(),'regions':[page['regions'][0]]}
        request=urllib.request.Request(f'http://127.0.0.1:{self.port}/ocr',data=json.dumps(body).encode(),headers={'Origin':'chrome-extension://fixture','Content-Type':'application/json'})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.headers['Access-Control-Allow-Origin'],'chrome-extension://fixture')
            data=json.load(response);self.assertEqual(data['regions'][0]['source'],page['regions'][0]['source'])
    def test_invalid_box(self):
        page=json.loads((ROOT/'artifacts/corpus/manifest.json').read_text(encoding='utf-8'))['pages'][0]
        body={'image':base64.b64encode((ROOT/'artifacts/corpus'/page['file']).read_bytes()).decode(),'regions':[{**page['regions'][0],'x':-100}]}
        req=urllib.request.Request(f'http://127.0.0.1:{self.port}/ocr',data=json.dumps(body).encode())
        with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
        self.assertEqual(error.exception.code,400)

if __name__=='__main__':unittest.main()
