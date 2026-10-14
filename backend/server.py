"""Foreground localhost OCR fallback. No PyTorch, keys, remote image fetching or persistence."""
import argparse, base64, io, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from PIL import Image
from vision import Vision

vision = Vision()

class Handler(BaseHTTPRequestHandler):
    def allowed_origin(self):
        origin = self.headers.get('Origin', '')
        return not origin or origin.startswith('chrome-extension://')

    def respond(self, status):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        if self.allowed_origin() and self.headers.get('Origin'):
            self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

    def do_OPTIONS(self):
        self.respond(204 if self.allowed_origin() else 403)

    def do_GET(self):
        self.respond(200 if self.path == '/health' else 404)
        self.wfile.write(json.dumps({'ok': self.path == '/health', 'backend': 'onnxruntime-cpu', 'version': '0.1.0'}).encode())

    def do_POST(self):
        if not self.allowed_origin() or self.path != '/ocr':
            self.respond(403)
            return
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 28 * 1024 * 1024:
            self.respond(413)
            return
        started = time.perf_counter()
        try:
            body = json.loads(self.rfile.read(size))
            data = base64.b64decode(body['image'], validate=True)
            image = Image.open(io.BytesIO(data)).convert('RGB')
            if image.width * image.height > 30_000_000:
                raise ValueError('Image too large')
            rows = body['regions']
            if not isinstance(rows, list) or len(rows) > 300:
                raise ValueError('Invalid regions')
            regions = []
            for row in rows:
                if not isinstance(row['id'], str) or not all(isinstance(row[k], (float, int)) for k in ['x','y','width','height']):
                    raise ValueError('Invalid region')
                if row['x'] < 0 or row['y'] < 0 or row['width'] <= 0 or row['height'] <= 0 or row['x'] + row['width'] > image.width + 1 or row['y'] + row['height'] > image.height + 1:
                    raise ValueError('Region outside image')
                if row.get('ocrBox'):
                    box=row['ocrBox']
                    if not all(isinstance(box[k],(float,int)) for k in ['x','y','width','height']) or box['x']<0 or box['y']<0 or box['width']<=0 or box['height']<=0 or box['x']+box['width']>image.width+1 or box['y']+box['height']>image.height+1:
                        raise ValueError('OCR crop outside image')
                text, warnings = vision.ocr(image, row)
                regions.append({'id': row['id'], 'source': text, 'warnings': warnings})
            self.respond(200)
            self.wfile.write(json.dumps({'regions': regions, 'backend': 'onnxruntime-cpu', 'ms': (time.perf_counter()-started)*1000}, ensure_ascii=False).encode('utf-8'))
        except Exception as error:
            self.respond(400)
            self.wfile.write(json.dumps({'error': str(error)}).encode())

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    print(f'OCR service: http://127.0.0.1:{args.port} (foreground; Ctrl+C to stop)', flush=True)
    HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
