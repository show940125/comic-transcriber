// Versions through 0.1.13 replaced a successful protocol result after any
// stream interruption. The final 30/30 validation progress is local evidence
// that the protocol passed before that unknown submission.
export function geminiProtocolPassed(validation:any,progress?:any):boolean{
  return validation?.status==='passed'||validation?.status==='blocked'&&progress?.completed===30&&progress?.total===30&&/結果未知/.test(validation?.error??'')&&!/HTTP\s*(403|429)/.test(validation?.error??'');
}
