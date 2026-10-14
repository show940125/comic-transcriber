// Long repeated OCR strings commonly arise on tiny lettering or image texture.
// Preserve the candidate for correction, but require review before machine translation.
export function needsOcrReview(text: string): boolean {
  const run=text.match(/(.)\1{15,}/u)?.[0];
  return Boolean(run && Array.from(text).length>=32 && Array.from(run).length/Array.from(text).length>=.6);
}
export const ocrReviewWarning='原文疑似重複辨識，已暫停自動翻譯；請核對並修正原文';
