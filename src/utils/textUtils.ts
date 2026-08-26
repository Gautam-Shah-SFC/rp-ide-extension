export function safeLength(text: string | null | undefined): number {
  return text ? text.length : 0;
}

export function nonEmpty(text: string | null | undefined): string {
  return text ?? "";
}
