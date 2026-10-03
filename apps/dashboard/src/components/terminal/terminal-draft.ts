/** A dictation draft is plain text: no Enter, escape sequence or control key. */
export function terminalDraftText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "");
}
