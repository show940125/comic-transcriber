"""Keep synthetic known-text metrics separate from AI visual-reference diagnostics."""
import re,unicodedata

def normalize(text):return ''.join(unicodedata.normalize('NFKC',text).split())
def distance(a,b):
    row=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        nxt=[i]
        for j,y in enumerate(b,1):nxt.append(min(nxt[-1]+1,row[j]+1,row[j-1]+(x!=y)))
        row=nxt
    return row[-1]

def evaluate(records,outputs,references):
    by_id={r['id']:r for r in outputs};refs={r['id']:r for r in references['rows']};groups={};details=[]
    for r in records:
        result=by_id.get(r['id'])
        if result is None:continue
        truth=r.get('reference') if r['dataset']!='real' else refs.get(r['id'],{}).get('source')
        text=result.get('source','')
        detail={'id':r['id'],'reference':truth,'source':text,'empty':not text.strip(),
                'repeated':bool(re.search(r'(.)\1{15,}',text)),'truncated':result.get('truncated'),
                'readingOrderError':None,'readingOrderReview':'pending visual review','ms':result.get('ms')}
        if truth is not None:
            a,b=normalize(truth),normalize(text)
            detail.update(edits=distance(a,b),chars=len(a),rawEdits=distance(truth,text),rawChars=len(truth),exact=a==b,rawExact=truth==text)
        details.append(detail)
        labels=[r['dataset']]
        if r['dataset']=='real':
            labels.append('real-'+r['section'])
            labels.extend('real-tag-'+tag for tag in refs.get(r['id'],{}).get('tags',[]))
        if r.get('category'):labels.append('synthetic-'+r['category'] if r['dataset']=='synthetic' else 'blank-'+r['category'])
        for label in labels:
            g=groups.setdefault(label,{'rows':0,'scored':0,'edits':0,'chars':0,'rawEdits':0,'rawChars':0,'exact':0,'rawExact':0,'empty':0,'repeated':0,'truncated':0,'blankHallucinations':0,'inferenceMs':0})
            g['rows']+=1;g['inferenceMs']+=result.get('ms',0)
            for key in ['empty','repeated','truncated']:g[key]+=int(bool(detail[key]))
            g['truncationUnknown']=g.get('truncationUnknown',0)+int(detail['truncated'] is None)
            g['readingOrderUnreviewed']=g.get('readingOrderUnreviewed',0)+1
            if r['dataset']=='blank':g['blankHallucinations']+=int(bool(text.strip()))
            if truth is not None:
                g['scored']+=1
                for key in ['edits','chars','rawEdits','rawChars','exact','rawExact']:g[key]+=detail[key]
    for label,g in groups.items():
        g.update(cer=g['edits']/g['chars'] if g['chars'] else None,rawCer=g['rawEdits']/g['rawChars'] if g['rawChars'] else None,exactRate=g['exact']/g['scored'] if g['scored'] else None)
        if label.startswith('real'):g['evidenceLevel']='AI visual reference, pending human; diagnostic only'
    return {'groups':groups,'details':details}

def parity(baseline,candidate):
    left={r['id']:r for r in baseline};right={r['id'] for r in candidate};rows=[]
    for r in candidate:
        b=left.get(r['id'])
        if not b:continue
        old=[s['token'] for s in b.get('steps',[])];new=[s['token'] for s in r.get('steps',[])]
        if b.get('tokens')!=r.get('tokens') or old!=new or b.get('ended')!=r.get('ended'):
            first=next((i for i,(x,y) in enumerate(zip(old,new)) if x!=y),min(len(old),len(new)))
            rows.append({'id':r['id'],'firstDifferentStep':first,'baseline':b['source'],'candidate':r['source'],'baselineTokens':b.get('tokens'),'candidateTokens':r.get('tokens')})
    missing=sorted(set(left)-right);extra=sorted(right-set(left))
    return {'compared':sum(r['id'] in left for r in candidate),'differences':rows,'missing':missing,'extra':extra,'identical':not rows and not missing and not extra}
