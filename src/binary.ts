export function imageBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export function imageBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length > 28 * 1024 * 1024) throw new Error('圖片訊息超過大小限制');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}
