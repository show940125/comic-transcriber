export const allWebOrigins=['http://*/*','https://*/*'];
export function isSpecificSite(pattern:string){
  // Chrome URL currently encodes a wildcard hostname as %2A while Node may
  // preserve '*'. Inspect the raw authority as well as the parsed hostname.
  const match=pattern.match(/^https?:\/\/([^/]+)\/\*$/i);if(!match||match[1].includes('*'))return false;
  try{const url=new URL(pattern);return /^https?:$/.test(url.protocol)&&!/[*%]/.test(url.hostname)&&!url.username&&!url.password&&url.pathname==='/*'&&!url.search&&!url.hash;}catch{return false;}
}
export function specificSites(patterns:string[]=[]){return [...new Set(patterns.filter(isSpecificSite))];}
// Called directly from a visible user click; Chrome handles consent if access
// was manually withheld. Required grants are otherwise already active.
export function requestAllWebAccess(){return chrome.permissions.request({origins:allWebOrigins});}
