"""Independent Apache-2.0 ONNX inference. Same preprocessing contract as extension."""
import pathlib, time
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

ROOT = pathlib.Path(__file__).resolve().parents[1]

class Vision:
    def __init__(self, threads=4):
        if threads not in (1, 2, 4):
            raise ValueError('threads must be 1, 2 or 4')
        self.threads = threads
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.options = options
        self.detector = None
        self.encoder = None
        self.decoder = None
        self.vocab = None

    def init_ocr(self):
        if self.encoder is not None:
            return
        directory = ROOT / '.cache/models/manga-ocr'
        self.encoder = ort.InferenceSession(str(directory / 'encoder_model.onnx'), sess_options=self.options, providers=['CPUExecutionProvider'])
        self.decoder = ort.InferenceSession(str(directory / 'decoder_model.onnx'), sess_options=self.options, providers=['CPUExecutionProvider'])
        self.vocab = (directory / 'vocab.txt').read_text(encoding='utf-8').splitlines()

    @staticmethod
    def crop_tensor(image, region=None):
        if region:
            region=region.get('ocrBox') or region
            x, y = region['x'], region['y']
            image = image.crop((x, y, x + region['width'], y + region['height']))
        image = ImageOps.grayscale(image).resize((224, 224), Image.Resampling.BILINEAR)
        array = (np.asarray(image, dtype=np.float32) / 255 - .5) * 2
        return np.stack([array] * 3)[None]

    def ocr(self, image, region):
        self.init_ocr()
        tensor = self.crop_tensor(image, region)
        if np.count_nonzero(tensor[0, 0] < -.2157) < 24 or np.count_nonzero(tensor[0, 0] > .2157) < 24:
            return '', ['疑似無文字，已略過']
        encoded = self.encoder.run(None, {self.encoder.get_inputs()[0].name: tensor})[0]
        tokens = [2]
        for _ in range(64):
            feeds = {input.name: encoded if ('encoder' in input.name or 'hidden' in input.name) else np.array([tokens], dtype=np.int64) for input in self.decoder.get_inputs()}
            logits = self.decoder.run(None, feeds)[0]
            token = int(np.argmax(logits[0, -1]))
            if token == 3:
                break
            tokens.append(token)
        text = ''.join(self.vocab[t] for t in tokens[1:] if t >= 5).replace('##', '').replace('[UNK]', '').replace(' ', '')
        return text, ['辨識長度到達上限'] if len(tokens) >= 64 else []

    def detect(self, image):
        if self.detector is None:
            self.detector = ort.InferenceSession(str(ROOT / '.cache/models/detector/detector-v4-s_int8.onnx'), sess_options=self.options, providers=['CPUExecutionProvider'])
        rgb = np.asarray(image.convert('RGB').resize((640, 640), Image.Resampling.BILINEAR), dtype=np.float32) / 255
        labels, boxes, scores = self.detector.run(None, {'images': np.transpose(rgb, (2, 0, 1))[None], 'orig_target_sizes': np.array([[image.width, image.height]], dtype=np.int64)})
        regions = []
        bubbles = []
        for label, box, score in zip(labels[0], boxes[0], scores[0]):
            if float(score) < (.6 if int(label) == 0 else .45):
                continue
            x, y, xx, yy = [float(x) for x in box]
            x, y = max(0, x), max(0, y)
            xx, yy = min(image.width, xx), min(image.height, yy)
            if xx <= x or yy <= y:
                continue
            entry = {'x': x, 'y': y, 'width': xx-x, 'height': yy-y, 'score': float(score), 'kind': 'free' if int(label) == 2 else 'bubble'}
            (bubbles if int(label) == 0 else regions).append(entry)
        refined = [self.ink_bounds(image, r) for r in bubbles]
        result = refined + [r for r in regions if not any(b['x'] < r['x']+r['width']/2 < b['x']+b['width'] and b['y'] < r['y']+r['height']/2 < b['y']+b['height'] for b in bubbles)]
        kept=[]
        for r in sorted(result,key=lambda r:-r['score']):
            if not any(self.iou(k,r)>.6 for k in kept): kept.append(r)
        return kept

    @staticmethod
    def iou(a,b):
        area=max(0,min(a['x']+a['width'],b['x']+b['width'])-max(a['x'],b['x']))*max(0,min(a['y']+a['height'],b['y']+b['height'])-max(a['y'],b['y']))
        return area/(a['width']*a['height']+b['width']*b['height']-area or 1)

    @staticmethod
    def ink_bounds(image,r):
        x,y,w,h=int(r['x']),int(r['y']),max(1,int(r['width'])),max(1,int(r['height']))
        rgb=np.asarray(image.crop((x,y,x+w,y+h)).convert('RGB'))
        gray=rgb[:,:,0]*.299+rgb[:,:,1]*.587+rgb[:,:,2]*.114
        mask=gray>170 if np.median(gray.reshape(-1)[::13])<128 else gray<110
        visited=np.zeros((h,w),dtype=bool);left,top,right,bottom=w,h,-1,-1
        for yy,xx in zip(*np.where(mask)):
            if visited[yy,xx]: continue
            stack=[(int(xx),int(yy))];visited[yy,xx]=True;x0,y0,x1,y1=w,h,-1,-1;count=0;border=False
            while stack:
                cx,cy=stack.pop();count+=1;x0=min(x0,cx);y0=min(y0,cy);x1=max(x1,cx);y1=max(y1,cy)
                if cx==0 or cy==0 or cx==w-1 or cy==h-1: border=True
                for dx,dy in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]:
                    nx,ny=cx+dx,cy+dy
                    if 0<=nx<w and 0<=ny<h and mask[ny,nx] and not visited[ny,nx]:visited[ny,nx]=True;stack.append((nx,ny))
            cx,cy=(x0+x1)/2,(y0+y1)/2
            density=count/((x1-x0+1)*(y1-y0+1))
            if border or count<3 or density<.12 or x1-x0>w*.65 or y1-y0>h*.65 or cx<w*.08 or cx>w*.92 or cy<h*.08 or cy>h*.92:continue
            left=min(left,x0);top=min(top,y0);right=max(right,x1);bottom=max(bottom,y1)
        ocr_box={'x':x,'y':y,'width':w,'height':h}
        if right<left:return {**r,'ocrBox':ocr_box}
        left,top=max(0,left-3),max(0,top-3)
        return {**r,'ocrBox':ocr_box,'x':x+left,'y':y+top,'width':min(w,right+4)-left,'height':min(h,bottom+4)-top}
