import { parseScript } from '../shared/script-parser';

export function parseScriptRequest(input: unknown) {
  return parseScript(input);
}
