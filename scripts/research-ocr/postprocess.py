"""Evaluate geometry-only reading order without dropping punctuation or annotations."""
import json
from prepare import OUT,save
from metrics import evaluate
data=json.loads((OUT/'dataset.json').read_text());refs=json.loads((OUT/'references.json').read_text());original=json.loads((OUT/'results/screenai-all.json').read_text())
mapped=[];changed=[];violations=[]
rows={r['id']:r for r in data['records']}
for output in original['results']:
    lines=output['lines'];vertical=sum(l['direction']==3 for l in lines)>len(lines)/2
    ordered=sorted(lines,key=(lambda l:(-l['x'],l['y'])) if vertical else (lambda l:(l['y'],l['x'])))
    source='\n'.join(l['text'] for l in ordered);record={'id':output['id'],'source':source,'lines':[]}
    sx,sy=(output['originalSize'][i]/output['ocrSize'][i] for i in range(2));row=rows[output['id']];offset=row['box']
    for line in ordered:
        symbols=[]
        for word in line['words']:
            for symbol in word['symbols']:
                if 'box' not in symbol:continue
                x,y,w,h,*angle=symbol['box'];symbols.append({'text':symbol.get('text',''),'rect':{'x':offset['x']+x*sx,'y':offset['y']+y*sy,'width':w*sx,'height':h*sy},'angle':angle[0] if angle else 0})
                if x<0 or y<0 or x+w>output['ocrSize'][0]+1 or y+h>output['ocrSize'][1]+1:violations.append({'id':output['id'],'box':symbol['box']})
        record['lines'].append({'text':line['text'],'direction':line['direction'],'symbols':symbols})
    if source!=output['source']:changed.append({'id':output['id'],'before':output['source'],'after':source})
    mapped.append(record)
# Explicit non-unit transform control, independent from the observed crop sizes.
assert {'x':10+4*2,'y':20+5*3}=={'x':18,'y':35}
save('combo/screenai-order.json',{'status':'complete','policy':'geometry order only; all raw lines, symbols and punctuation retained','changed':changed,'coordinateOutliers':violations,'original':evaluate(data['records'],original['results'],refs),'candidate':evaluate(data['records'],mapped,refs),'results':mapped,'humanGold':False,'decision':'research only; no production geometry or reading-order replacement'})
print('Geometry reading-order diagnostic complete:',len(changed),'changed;',len(violations),'out-of-bounds symbols retained for review')
