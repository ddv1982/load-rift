const MAX_LIVE_LOG_CHARS = 128 * 1024;
const LOG_TRUNCATION_NOTICE =
  "[Load Rift truncated earlier k6 output to keep the app responsive.]\n";

export function appendLogOutput(previous: string, next: string): string {
  return truncateLogTail(`${previous}${next}`);
}

export function truncateLogTail(log: string): string {
  if (log.length <= MAX_LIVE_LOG_CHARS) {
    return log;
  }

  const retainLength = Math.max(
    0,
    MAX_LIVE_LOG_CHARS - LOG_TRUNCATION_NOTICE.length,
  );
  return `${LOG_TRUNCATION_NOTICE}${log.slice(-retainLength)}`;
}
