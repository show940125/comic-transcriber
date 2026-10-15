// Readiness probes are side-effect free. Inference/translation messages are
// dispatched only once after this handshake, never replayed on a lost reply.
export async function waitForOffscreenReady(send:()=>Promise<unknown>,{timeoutMs=10_000,intervalMs=50}={}){
  const deadline=Date.now()+timeoutMs;
  const timeout=()=>new Error('推論文件在 10 秒內未能就緒；已保留進度，請稍後續翻');
  const poll=async()=>{while(true){
    try{const response=await send() as {ok?:boolean;ready?:boolean}|undefined;if(response?.ok&&response.ready)return;}
    catch(error){if(!/Could not establish connection\. Receiving end does not exist\.?/.test(String(error)))throw error;}
    if(Date.now()>=deadline)throw timeout();
    await new Promise(resolve=>setTimeout(resolve,Math.min(intervalMs,Math.max(0,deadline-Date.now()))));
  }};
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([poll(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(timeout()),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
