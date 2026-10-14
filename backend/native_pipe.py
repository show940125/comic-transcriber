"""One foreground local CPU translation request over stdin/stdout; no daemon."""
import sys,json
from native_llm import complete
data=json.load(sys.stdin)
text,ms=complete(data['messages'],data.get('model','qwen3.5-2b'),1000)
print(json.dumps({'content':text,'ms':ms,'backend':'llama.cpp-cpu'},ensure_ascii=False))
