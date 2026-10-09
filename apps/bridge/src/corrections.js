// Correzioni dopo la trascrizione: errori ricorrenti di Whisper sui termini tecnici dettati in italiano.
// Ogni regola nasce da un errore osservato (commento a lato). Regole prudenti: "cloud" è anche una parola
// legittima, quindi diventa "Claude" solo dove il contesto è inequivocabile.

const RULES = [
  // "Cloud Code", "CrudeCode", "Clod code"… → Claude Code
  [/\b(?:cloud|crude|claud|clod|clode|cloude|cloud's)[\s-]*code\b/gi, 'Claude Code'],
  // "Cloud, apri…": rivolto all'assistente a inizio frase
  [/(^|[.!?]\s+)(?:cloud|crude|clod|clode|cloude),/gi, '$1Claude,'],
  // "npm-ram-xr", "npm rum dev" → npm run xr / npm run dev
  [/\bnpm[\s-]+(?:ram|rum|ran|ron|run)[\s-]+([\w:]+)/gi, 'npm run $1'],
  // "Type Check", "tab check", "TypeCheck" → typecheck
  [/\b(?:type|tab|tipe)[\s-]?check\b/gi, 'typecheck'],
  // "fai un comment con il messaggio" → commit (solo davanti a "con il messaggio" / "e push")
  [/\bcomment(?=\s+(?:con il messaggio|e (?:un )?push))/gi, 'commit'],
];

export function correct(text) {
  return RULES.reduce((t, [re, repl]) => t.replace(re, repl), text);
}
