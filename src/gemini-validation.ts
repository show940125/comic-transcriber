// Older versions replaced protocol success after stream interruption or the
// local cumulative-response cap. Reuse only explicit 30/30 local proof for
// these known client failures; submitted/unknown request locks remain intact.
export function geminiProtocolPassed(validation:any,progress?:any):boolean{
  return validation?.status==='passed'||validation?.status==='blocked'&&progress?.completed===30&&progress?.total===30&&/結果未知|Gemini 回覆超過大小限制/.test(validation?.error??'')&&!/HTTP\s*(403|429)/.test(validation?.error??'');
}
