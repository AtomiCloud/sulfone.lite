'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="command-block">
      <span>{label}</span>
      <code>{command}</code>
      <button aria-label={`Copy ${label}`} onClick={() => void copyCommand()} type="button">
        {copied ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
