"""One alternative converter attempt after the first converter's parity failure."""
import json,time
from pathlib import Path
from prepare import OUT,save,sha
import tflite2onnx

source=Path.home()/'AppData/Local/Google/Chrome/User Data/screen_ai/153.4/gocr/gocr_models/line_recognition_mobile_convnext320_omni/hanijpan.tflite'
target=OUT/'portable/hanijpan-tflite2onnx.onnx';started=time.perf_counter()
report={'tool':'tflite2onnx','status':'running','reason':'tf2onnx graph runs, but uint8 output/argmax parity did not pass','sourceSha256':sha(source)}
try:
    tflite2onnx.convert(str(source),str(target))
    report.update(status='converted',sha256=sha(target),bytes=target.stat().st_size)
except Exception as error:report.update(status='conversion-failed',error=repr(error))
report['seconds']=time.perf_counter()-started;save('portable/alternate-converter.json',report);print(json.dumps(report))
