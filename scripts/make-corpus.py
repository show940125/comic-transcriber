"""30 original synthetic comic pages / 300 dialogue regions. Not real-manga acceptance."""
import json, pathlib, random, hashlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/corpus'
(OUT / 'pages').mkdir(parents=True, exist_ok=True)
FONT = pathlib.Path('C:/Windows/Fonts/YuGothR.ttc')
texts = [
 ('今日はいい天気だね。', '今天天氣真好。'), ('一緒に帰ろう。', '一起回家吧。'),
 ('ちょっと待って！', '等一下！'), ('君の名前は？', '你叫什麼名字？'), ('ありがとう。', '謝謝。'),
 ('大丈夫ですか？', '你還好嗎？'), ('そんなことないよ。', '才沒有那回事。'), ('明日また会おう。', '明天再見。'),
 ('約束したからね。', '我們說好了喔。'), ('何があったの？', '發生什麼事了？'),
 ('この本を読んで。', '讀讀這本書。'), ('誰もいない。', '一個人也沒有。'), ('本当にそう思う？', '你真的這麼想？'),
 ('もう時間がない！', '已經沒時間了！'), ('ここで待ってる。', '我在這裡等你。'), ('無理しないで。', '別勉強自己。'),
 ('先生が来たよ。', '老師來了。'), ('これ、君にあげる。', '這個送你。'), ('帰りたくない。', '我不想回去。'), ('私を信じて。', '相信我。'),
]
pages = []
for page_index in range(30):
    random.seed(page_index)
    image = Image.new('RGB', (1000, 1500), 'white')
    draw = ImageDraw.Draw(image)
    regions = []
    mode = ['horizontal', 'vertical', 'low-resolution', 'white-on-black', 'furigana', 'textured'][page_index % 6]
    for row in range(5):
        for col in [1, 0]:
            n = len(regions)
            x, y = 35 + col * 500, 30 + row * 290
            draw.rectangle((x, y, x+425, y+265), outline='#777777', width=2)
            # Original schematic panel art, excluded from text ground truth.
            draw.ellipse((x+15,y+175,x+85,y+245),outline='#666666',width=3)
            draw.line((x+50,y+245,x+50,y+260),fill='#666666',width=3)
            vertical = mode in ['vertical', 'furigana']
            rect = (x+115,y+35,x+395,y+210) if not vertical else (x+170,y+20,x+345,y+245)
            black = mode == 'white-on-black'
            draw.rounded_rectangle(rect,radius=35,fill='black' if black else 'white',outline='black',width=2)
            ja, zh = texts[(page_index * 7 + n) % len(texts)]
            font = ImageFont.truetype(str(FONT),32 if not vertical else 28)
            glyph_boxes=[]
            if vertical:
                lines = [ja[i:i+7] for i in range(0,len(ja),7)]
                tx = rect[2] - 52
                for line in lines:
                    ty = rect[1] + 12
                    for char in line:
                        draw.text((tx,ty),char,font=font,fill='black'); glyph_boxes.append(draw.textbbox((tx,ty),char,font=font)); ty += 28
                    tx -= 36
                rx, ry, rw, rh = tx+36, rect[1]+9, rect[2]-tx-54, min(208,max(len(line) for line in lines)*28+6)
                if mode == 'furigana':
                    ruby = ImageFont.truetype(str(FONT),10)
                    draw.text((rect[2]-15,rect[1]+35),'きょう',font=ruby,fill='black'); glyph_boxes.append(draw.textbbox((rect[2]-15,rect[1]+35),'きょう',font=ruby))
            else:
                lines = [ja[i:i+7] for i in range(0,len(ja),7)]
                tx, ty = rect[0]+20, rect[1]+40
                for line in lines:
                    draw.text((tx,ty),line,font=font,fill='white' if black else 'black'); glyph_boxes.append(draw.textbbox((tx,ty),line,font=font)); ty += 42
                rx, ry, rw, rh = tx-4,rect[1]+35, min(245, max(len(line) for line in lines)*32+8),len(lines)*42+6
            if mode == 'textured':
                for dot in range(120):
                    dx,dy=random.randint(x+1,x+424),random.randint(y+1,y+264)
                    if not (rect[0] < dx < rect[2] and rect[1] < dy < rect[3]): draw.point((dx,dy),fill='#bbbbbb')
            gx=min(b[0] for b in glyph_boxes)-3;gy=min(b[1] for b in glyph_boxes)-3
            gw=max(b[2] for b in glyph_boxes)+3-gx;gh=max(b[3] for b in glyph_boxes)+3-gy
            regions.append({'id': f'p{page_index+1:02}-r{n+1:02}','x':gx,'y':gy,'width':gw,'height':gh,'order':n,'source':ja,'reference':zh,'kind':'bubble','score':1,'warnings':[],'translation':'','render':'auto'})
    if mode == 'low-resolution': image = image.resize((500,750)).resize((1000,1500))
    filename=f'page-{page_index+1:02}.png'; path=OUT/'pages'/filename; image.save(path)
    pages.append({'file':'pages/'+filename,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'category':mode,'regions':regions,'blank':{'x':0,'y':0,'width':20,'height':20,'id':'blank'}})
(OUT/'manifest.json').write_text(json.dumps({'schema':1,'annotationVersion':2,'annotationMethod':'Pillow textbbox union + 3 pixel margin; independent of model prediction','license':'CC0-1.0 original dialogues and schematic art; system font not redistributed','purpose':'synthetic functional and OCR benchmark, not real-manga acceptance','pages':pages},ensure_ascii=False,indent=2),encoding='utf-8')
print('Created 30 original synthetic pages, 300 dialogue regions.')
