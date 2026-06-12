// Minimal syntax highlighter stub (no shiki to keep bundle size small)
import { type FC } from "react";

interface SyntaxHighlighterProps {
  language: string;
  code: string;
}

export const SyntaxHighlighter: FC<SyntaxHighlighterProps> = ({ code }) => (
  <code>{code}</code>
);
