// Helpers shared by the language adapters' trace commands.
import { plainToSer } from './types.js';

/** Split the program's stdout into what the user printed and the driver's result line. */
export function finishTrace(result, stdout, toTrace = plainToSer) {
  const i = stdout.lastIndexOf('\u0001LV ');
  let printed = stdout;
  if (i >= 0) {
    const tail = stdout.slice(i + 4).split('\n')[0];
    printed = stdout.slice(0, i).replace(/\n$/, '');
    let parsed;
    try { parsed = JSON.parse(tail); } catch {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.err === 'string') {
      result.error ||= parsed.err;
    } else if (!result.error && !result.truncated) {
      result.returnPlain = tail;
      if (parsed !== undefined) result.returnValue = toTrace(parsed);
    }
  }
  result.stdout = printed.slice(0, 20000);
  return result;
}
